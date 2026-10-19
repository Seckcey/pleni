// The Models page: which model and effort Codex and Claude Code agents start with. For Codex, Pleni
// reads its settings file (config.toml), the worker types in its agents folder, and the list of
// models Codex keeps for the account (models_cache.json). For Claude Code, it reads settings.json and
// the agent files in its agents folder. With settings.models.edit on, the person can change them from
// the page on this computer. Pleni then changes only those values (src/toml.js and
// src/frontmatter.js keep every other byte; settings.json keeps every other key), after it saves a
// copy of each file in its own folder. It never writes a file it could not read back, it stops when a
// file changed since the page looked, and for Codex it offers only the models and effort levels
// Codex lists, because Codex refuses to start a worker with any other.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { renameWithRetry } from './config.js';
import { frontmatterText, removeFrontmatterKey, scanFrontmatter, setFrontmatterValue, yamlValue } from './frontmatter.js';
import { stripBom } from './jsonl.js';
import { modelLabel } from './model.js';
import { removeTomlKey, scanToml, setTomlText, tomlString, tomlText } from './toml.js';

// The effort levels Codex knows, lowest first. Codex's model list says which ones each model takes.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const EFFORT_NAMES = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'extra high', max: 'max', ultra: 'ultra' };
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;
const EFFORT_WORD = /^[a-z][a-z0-9_-]{0,19}$/;
const TYPE_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
// Codex's own worker types; a file with one of these names would replace it.
const BUILT_IN_TYPES = new Set(['default', 'explorer', 'worker']);
// Names such as con or nul are devices, not files, on Windows.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/;
const TYPE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_FILE = 256 * 1024;
const MAX_CATALOG = 4 * 1024 * 1024;
const MAX_TYPES = 50;
const TYPE_DEPTH = 3;
const MAX_DESCRIPTION = 300;
const MAX_MODELS = 60;
const KEEP_BACKUPS = 20;
const SAVES_PER_MINUTE = 10;
const MINUTE_MS = 60 * 1000;
export const PLENI_MARK = '# Made by Pleni (Settings > Models).';

// Where each choice lives in config.toml.
const LINES = {
  sergeant: { model: ['model'], effort: ['model_reasoning_effort'] },
  worker: { model: ['agents', 'default_subagent_model'], effort: ['agents', 'default_subagent_reasoning_effort'] },
};
const TYPE_LINES = { model: ['model'], effort: ['model_reasoning_effort'] };
const LINE_NAMES = {
  'model': 'The line model',
  'model_reasoning_effort': 'The line model_reasoning_effort',
  'agents.default_subagent_model': 'The line default_subagent_model under [agents]',
  'agents.default_subagent_reasoning_effort': 'The line default_subagent_reasoning_effort under [agents]',
};

export const MODELS_MESSAGES = {
  off: 'Changing models from Pleni is turned off. Turn it on in Settings, under Models, first.',
  remote: 'Models can be changed only on the computer that runs Pleni, not from another device.',
  demo: 'The demo has no real Codex settings to change.',
  noRoot: 'Pleni does not know where Codex keeps its settings. Check the Codex folder in Settings, under Sources.',
  changed: "Codex's settings changed since you looked, so Pleni changed nothing. Check what they say now, then save again.",
  unreadable: "Pleni could not read Codex's settings file, so it changed nothing. Fix the file, or change models in Codex.",
  notText: "Codex's settings file is not plain text that Pleni can read back, so it changed nothing.",
  tooBig: "Codex's settings file is too big for Pleni to change.",
  badModel: 'That is not a model name Pleni can save. Use letters, digits and . - _ : / @ + only, up to 100 of them.',
  unknownModel: 'Codex does not list that model for you, so agents could not start with it. Pick one from the list.',
  badEffort: 'Pick an effort level from the list.',
  badType: 'Pleni does not know that worker type. Look again.',
  badName: 'A worker type name starts with a small letter and has only small letters, digits, - and _, up to 40 of them.',
  builtInName: 'Codex has a worker type with that name already. Pick another name.',
  deviceName: 'Windows keeps that name for itself. Pick another name.',
  takenName: 'There is a worker type with that name already.',
  badDescription: `Say when a sergeant should use this worker type, in up to ${MAX_DESCRIPTION} letters.`,
  nothing: 'Nothing to change.',
  tooMany: 'Pleni saved models a few times just now. Wait a minute, then try again.',
  failed: 'Pleni could not save the change. Try again, or check that no other program holds the file.',
};

// What the page shows for Codex: { ok, error, folder, file, found, tag, listed, sergeant, worker,
// types, models, efforts }. `listed` says whether Codex keeps a model list here; without one, the
// page offers the models in use and lets the person type a name. `seen` holds the models of the
// Codex sessions on the map, most used first.
export function readCodexModels({ root, seen = [] }) {
  const base = {
    ok: false, error: null, folder: root ?? null, file: null, found: false, tag: null, listed: false,
    sergeant: null, worker: null, types: [], models: [], efforts: [...EFFORTS],
  };
  if (!root) return { ...base, error: MODELS_MESSAGES.noRoot };
  const state = readState(root);
  const out = { ...base, file: state.config.file, found: state.config.exists, tag: state.tag };
  if (state.config.problem) return { ...out, error: problemText(state.config.problem) };
  const lines = scanToml(state.config.text);
  if (!lines.ok) return { ...out, error: MODELS_MESSAGES.unreadable };
  const pick = (paths) => ({ model: lineState(lines.items, paths.model), effort: lineState(lines.items, paths.effort) });
  const catalog = readCatalog(root);
  out.ok = true;
  out.listed = catalog.length > 0;
  out.sergeant = pick(LINES.sergeant);
  out.worker = pick(LINES.worker);
  out.types = state.types.map(typeView);
  const set = [out.sergeant.model.value, out.worker.model.value, ...out.types.map((t) => t.model?.value)];
  out.models = modelChoices(catalog, seen, set);
  out.efforts = effortList(catalog);
  return out;
}

// Changes Codex's model lines. `changes` is
// { sergeant?: { model?, effort? }, worker?: { model?, effort? }, types?: [{ file, model?, effort? }],
//   add?: { name, description, model } }, where a missing field stays as it is and null takes the
// line out (back to Codex's own default). `tag` is the one the page was shown, so a file that
// changed since stops the save. Answers { ok: true, files, backups } or { ok: false, status, error }.
// `app` is 'codex' (the default) or 'claude', whose changes are the same except that a worker has
// no effort of its own (see planClaude). It runs from start to end without waiting, so two saves
// never mix.
export function createModelSaver({ now = Date.now } = {}) {
  const times = [];

  function save({ app = 'codex', root, backupDir, tag, changes }) {
    const claude = app === 'claude';
    if (!root) return refuse(409, claude ? CLAUDE_MESSAGES.noRoot : MODELS_MESSAGES.noRoot);
    const t = now();
    while (times.length && t - times[0] >= MINUTE_MS) times.shift();
    if (times.length >= SAVES_PER_MINUTE) return refuse(429, MODELS_MESSAGES.tooMany);
    const plan = claude ? planClaude(root, tag, changes) : planChanges(root, tag, changes);
    if (!plan.ok) return plan;
    if (!plan.files.length) return { ok: true, files: [], backups: [] };
    times.push(t);
    return writePlan(plan.files, backupDir, t, claude ? 'claude' : 'codex');
  }

  return { save };
}

// ---- reading ----

function readState(root) {
  const config = readFileText(path.join(root, 'config.toml'));
  const types = readTypes(path.join(root, 'agents'), '.toml');
  const tag = tagOf([['config.toml', config], ...types.map((t) => [`agents/${t.id}`, t])]);
  return { config, types, tag };
}

// { file, exists, text, bytes, problem }: text is '' for a file that is not there yet.
function readFileText(file, max = MAX_FILE) {
  let bytes;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { file, exists: true, text: null, bytes: null, problem: 'unreadable' };
    if (stat.size > max) return { file, exists: true, text: null, bytes: null, problem: 'tooBig' };
    bytes = fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return { file, exists: false, text: '', bytes: null, problem: null };
    return { file, exists: true, text: null, bytes: null, problem: 'unreadable' };
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return { file, exists: true, text: null, bytes, problem: 'notText' };
  return { file, exists: true, text, bytes, problem: null };
}

function problemText(problem) {
  return MODELS_MESSAGES[problem] ?? MODELS_MESSAGES.unreadable;
}

// The worker type files: every file ending in `ext` in the agents folder and the folders in it, as
// Codex and Claude Code read them. `id` is the path inside the agents folder, with "/" between folders.
function readTypes(dir, ext) {
  const out = [];
  const walk = (folder, parts) => {
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      return;
    }
    for (const d of entries) {
      if (out.length >= MAX_TYPES) return;
      if (d.isFile() && TYPE_FILE.test(d.name) && d.name.endsWith(ext) && d.name.length > ext.length) {
        const id = [...parts, d.name].join('/');
        out.push({ id, ...readFileText(path.join(folder, d.name)) });
      } else if (d.isDirectory() && TYPE_FILE.test(d.name) && parts.length + 1 < TYPE_DEPTH) {
        walk(path.join(folder, d.name), [...parts, d.name]);
      }
    }
  };
  walk(dir, []);
  return out;
}

function typeView(t) {
  const out = { file: t.id, name: null, description: null, model: null, effort: null, pleni: false, error: null };
  if (t.problem) return { ...out, error: problemText(t.problem) };
  const lines = scanToml(t.text);
  if (!lines.ok) return { ...out, error: 'Pleni could not read this file.' };
  const text = (key, max) => plain(tomlText(lines.items, [key]).text, max);
  return {
    ...out,
    name: text('name', 40),
    description: text('description', MAX_DESCRIPTION),
    model: lineState(lines.items, TYPE_LINES.model),
    effort: lineState(lines.items, TYPE_LINES.effort),
    pleni: stripBom(t.text).startsWith(PLENI_MARK),
  };
}

// { value, set, editable }: `set` is false when the line is not there, `value` is null unless it is
// a plain text value.
function lineState(items, linePath) {
  const now = tomlText(items, linePath);
  return { value: now.text, set: now.found, editable: now.editable };
}

function plain(value, max) {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/\p{Cc}+/gu, ' ').trim();
  return flat ? Array.from(flat).slice(0, max).join('') : null;
}

function tagOf(parts) {
  const hash = crypto.createHash('sha256');
  for (const [name, file] of parts) {
    hash.update(`${name}\0${file.exists ? (file.bytes ? file.bytes.length : 'x') : 'none'}\0`);
    if (file.bytes) hash.update(file.bytes);
  }
  return hash.digest('hex').slice(0, 24);
}

// ---- the model list ----

// The models Codex lists for this account, from the models_cache.json it keeps fresh, lowest
// priority first: [{ id, label, efforts: [...] | null, defaultEffort, hidden }]. `hidden` ones are
// left out of Codex's own picker, but Codex still starts agents with them. Empty when there is none.
export function readCatalog(root) {
  // Codex writes this file in place, so a read in the middle of a write is tried once more.
  for (let attempt = 0; attempt < 2; attempt++) {
    const file = readFileText(path.join(root, 'models_cache.json'), MAX_CATALOG);
    if (!file.text) return [];
    let raw;
    try {
      raw = JSON.parse(stripBom(file.text));
    } catch {
      continue;
    }
    const list = Array.isArray(raw?.models) ? raw.models : [];
    return list
      .map((m, i) => catalogEntry(m, i))
      .filter(Boolean)
      .sort((a, b) => a.priority - b.priority || a.order - b.order)
      .slice(0, MAX_MODELS)
      .map(({ priority, order, ...m }) => m);
  }
  return [];
}

function catalogEntry(raw, order) {
  if (!raw || typeof raw !== 'object' || typeof raw.slug !== 'string' || !MODEL_ID.test(raw.slug)) return null;
  const levels = Array.isArray(raw.supported_reasoning_levels) ? raw.supported_reasoning_levels : [];
  const efforts = [...new Set(levels.map((l) => (typeof l === 'string' ? l : l?.effort)).filter((l) => typeof l === 'string' && EFFORT_WORD.test(l)))];
  return {
    id: raw.slug,
    label: plain(raw.display_name, 60) || modelLabel(raw.slug) || raw.slug,
    efforts: efforts.length ? efforts : null,
    defaultEffort: typeof raw.default_reasoning_level === 'string' && EFFORT_WORD.test(raw.default_reasoning_level) ? raw.default_reasoning_level : null,
    hidden: raw.visibility !== undefined && raw.visibility !== 'list',
    priority: Number.isFinite(raw.priority) ? raw.priority : Infinity,
    order,
  };
}

// The models the page offers: [{ id, label, efforts, defaultEffort, unlisted }]. With Codex's list,
// its models (not the hidden ones), then any model a line names, marked `unlisted` when Codex does
// not list it. Without one, the models the sessions on the map use, then the ones the lines name.
export function modelChoices(catalog, seen, set) {
  const out = new Map(catalog.filter((m) => !m.hidden).map(({ hidden, ...m }) => [m.id, { ...m, unlisted: false }]));
  const known = new Map(catalog.map((m) => [m.id, m]));
  for (const id of [...(catalog.length ? [] : seen), ...set]) {
    if (typeof id !== 'string' || !MODEL_ID.test(id) || out.has(id) || out.size >= MAX_MODELS) continue;
    const listed = known.get(id);
    if (listed) out.set(id, { id, label: listed.label, efforts: listed.efforts, defaultEffort: listed.defaultEffort, unlisted: false });
    else out.set(id, { id, label: modelLabel(id) || id, efforts: null, defaultEffort: null, unlisted: catalog.length > 0 });
  }
  return [...out.values()];
}

function effortList(catalog) {
  const more = catalog.flatMap((m) => m.efforts ?? []).filter((e) => !EFFORTS.includes(e));
  return [...EFFORTS, ...new Set(more)];
}

// ---- saving ----

// Works out every new file first, so nothing is written unless all of it can be.
function planChanges(root, tag, changes) {
  if (!changes || typeof changes !== 'object') return refuse(400, MODELS_MESSAGES.nothing);
  const state = readState(root);
  if (typeof tag !== 'string' || tag !== state.tag) return refuse(409, MODELS_MESSAGES.changed);
  if (state.config.problem) return refuse(409, problemText(state.config.problem));
  const lines = scanToml(state.config.text);
  if (!lines.ok) return refuse(409, MODELS_MESSAGES.unreadable);
  const catalog = readCatalog(root);
  const files = [];

  const edits = [];
  for (const who of ['sergeant', 'worker']) {
    if (changes[who] === undefined) continue;
    const asked = checkPair(changes[who], LINES[who], lines.items, catalog);
    if (!asked.ok) return asked;
    edits.push(...asked.edits);
  }
  const config = applyEdits(state.config.text, edits);
  if (!config.ok) return config;
  if (config.text !== state.config.text) files.push({ ...state.config, next: config.text });

  for (const want of Array.isArray(changes.types) ? changes.types : []) {
    const type = state.types.find((t) => want && t.id === want.file);
    if (!type) return refuse(404, MODELS_MESSAGES.badType);
    if (type.problem) return refuse(409, problemText(type.problem));
    const typeLines = scanToml(type.text);
    if (!typeLines.ok) return refuse(409, MODELS_MESSAGES.unreadable);
    const asked = checkPair(want, TYPE_LINES, typeLines.items, catalog);
    if (!asked.ok) return asked;
    const next = applyEdits(type.text, asked.edits);
    if (!next.ok) return next;
    if (next.text !== type.text) files.push({ ...type, next: next.text });
  }

  if (changes.add !== undefined) {
    const add = newType(changes.add, state.types, catalog);
    if (!add.ok) return add;
    files.push({ file: path.join(root, 'agents', `${add.name}.toml`), exists: false, text: '', bytes: null, next: add.text, create: true });
  }
  return { ok: true, files };
}

// Checks one model and effort pair: each value on its own, then the effort against the model it
// goes with, as Codex will. Answers { ok: true, edits: [[line, value]] } or a refusal.
function checkPair(want, paths, items, catalog) {
  if (!want || typeof want !== 'object') return refuse(400, MODELS_MESSAGES.nothing);
  const edits = [];
  for (const what of ['model', 'effort']) {
    if (!Object.hasOwn(want, what)) continue;
    const bad = what === 'model' ? modelProblem(want.model, catalog) : effortProblem(want.effort, catalog);
    if (bad) return refuse(400, bad);
    edits.push([paths[what], want[what]]);
  }
  if (!edits.length) return { ok: true, edits };
  const model = Object.hasOwn(want, 'model') ? want.model : tomlText(items, paths.model).text;
  const effort = Object.hasOwn(want, 'effort') ? want.effort : tomlText(items, paths.effort).text;
  const listed = model ? catalog.find((m) => m.id === model) : null;
  if (effort && listed?.efforts && !listed.efforts.includes(effort)) {
    return refuse(400, `${listed.label} does not take ${EFFORT_NAMES[effort] ?? effort} effort. Pick another effort level.`);
  }
  return { ok: true, edits };
}

function modelProblem(value, catalog) {
  if (value === null) return null;
  if (typeof value !== 'string' || !MODEL_ID.test(value)) return MODELS_MESSAGES.badModel;
  return catalog.length && !catalog.some((m) => m.id === value) ? MODELS_MESSAGES.unknownModel : null;
}

function effortProblem(value, catalog) {
  if (value === null) return null;
  return typeof value === 'string' && effortList(catalog).includes(value) ? null : MODELS_MESSAGES.badEffort;
}

function applyEdits(source, edits) {
  let text = source;
  for (const [line, value] of edits) {
    const done = value === null ? removeTomlKey(text, line) : setTomlText(text, line, value);
    if (!done.ok) {
      if (done.error === 'unreadable') return refuse(409, MODELS_MESSAGES.unreadable);
      const name = LINE_NAMES[line.join('.')] ?? `The line ${line.join('.')}`;
      return refuse(409, `Pleni can change only a simple line such as model = "gpt-6.1-sol". ${name} is written another way, so Pleni changed nothing. Change it in the file instead.`);
    }
    text = done.text;
  }
  // Read it back: the new file must say exactly what was asked.
  const check = scanToml(text);
  if (!check.ok) return refuse(409, MODELS_MESSAGES.unreadable);
  for (const [line, value] of edits) {
    const now = tomlText(check.items, line);
    if (value === null ? now.found : now.text !== value) return refuse(409, MODELS_MESSAGES.unreadable);
  }
  return { ok: true, text };
}

// A new worker type file. Codex drops a type whose file has a key it does not know, so it holds
// only name, description, model and developer_instructions (which Codex needs).
function newType(raw, types, catalog) {
  if (!raw || typeof raw !== 'object') return refuse(400, MODELS_MESSAGES.badName);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!TYPE_NAME.test(name)) return refuse(400, MODELS_MESSAGES.badName);
  if (BUILT_IN_TYPES.has(name)) return refuse(400, MODELS_MESSAGES.builtInName);
  if (WINDOWS_DEVICE.test(name)) return refuse(400, MODELS_MESSAGES.deviceName);
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (!description || Array.from(description).length > MAX_DESCRIPTION || /\p{Cc}/u.test(description)) return refuse(400, MODELS_MESSAGES.badDescription);
  const model = raw.model ?? null;
  const bad = modelProblem(model, catalog);
  if (bad) return refuse(400, bad);
  const taken = types.some((t) => t.id.toLowerCase() === `${name}.toml` || typeName(t) === name);
  if (taken) return refuse(409, MODELS_MESSAGES.takenName);
  const lines = [
    `${PLENI_MARK} Pleni changes only its model lines, when you ask it to.`,
    `name = ${tomlString(name)}`,
    `description = ${tomlString(description)}`,
    ...(model ? [`model = ${tomlString(model)}`] : []),
    'developer_instructions = """',
    'Do the task you were given. When you finish, say what you did and what is left to do.',
    '"""',
    '',
  ];
  return { ok: true, name, text: lines.join('\n') };
}

function typeName(t) {
  if (!t.text) return null;
  const lines = scanToml(t.text);
  return lines.ok ? tomlText(lines.items, ['name']).text?.trim() ?? null : null;
}

// ---- Claude Code ----

// The effort levels Claude Code keeps for a model in settings.json (max lasts one session only), and
// the ones an agent file may name.
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
export const CLAUDE_TYPE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Short names that Claude Code points at its newest models, so they never go out of date.
export const CLAUDE_ALIASES = [['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const ALIAS_IDS = new Set(CLAUDE_ALIASES.map(([id]) => id));
const CLAUDE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]{0,99}$/;
// Claude Code's own agents; a file with one of these names would stand in for it.
const CLAUDE_BUILT_IN = new Set(['general-purpose', 'explore', 'plan', 'statusline-setup', 'claude-code-guide', 'fork']);
const SUBAGENT_MODEL = 'CLAUDE_CODE_SUBAGENT_MODEL';
// Settings that win over what the page sets, so the page warns about them. Only these few names
// are read from the environment.
const OVERRIDES = [
  ['ANTHROPIC_MODEL', (v) => `ANTHROPIC_MODEL is set to ${v}, so new sessions run on that model, not the one below.`],
  ['CLAUDE_CODE_EFFORT_LEVEL', (v) => `CLAUDE_CODE_EFFORT_LEVEL is set to ${v}. It wins over every effort below, and over the effort a sergeant picks for a worker.`],
  ['CLAUDE_CODE_SUBAGENT_MODEL_FORCE', () => 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE is set, so every worker runs on the worker model below, whatever its sergeant or its type says.'],
];

export const CLAUDE_MESSAGES = {
  noRoot: 'Pleni does not know where Claude Code keeps its settings. Check the Claude Code folder in Settings, under Sources.',
  changed: "Claude Code's settings changed since you looked, so Pleni changed nothing. Check what they say now, then save again.",
  unreadable: "Pleni could not read Claude Code's settings file (settings.json), so it changed nothing. Fix the file, or change models in Claude Code.",
  badModel: 'That is not a model name Pleni can save. Use letters, digits and . - _ : / @ + [ ] only, up to 100 of them.',
  badEffort: 'Pick an effort level from the list.',
  needModel: 'Pick a model for sergeants first. Claude Code keeps an effort for each model.',
  noWorkerEffort: 'Claude Code has no setting for the effort of a worker. Each sergeant picks it.',
  notSimple: (what) => `${what} in Claude Code's settings is written in a way Pleni does not change, so Pleni changed nothing. Change it in the file instead.`,
  noBlock: 'This file has no settings block at the top, so Claude Code does not use it.',
  badFile: 'Pleni could not read this file.',
  builtInName: 'Claude Code has an agent with that name already. Pick another name.',
};

// What the page shows for Claude Code, in the same shape as readCodexModels, plus `modelEfforts`
// (the effort Claude Code keeps for each model on the list), `typeEfforts` and `notes` (settings
// that win over this page). A worker has no effort of its own here (`worker.effort` is null).
export function readClaudeModels({ root, seen = [], env = process.env }) {
  const base = {
    ok: false, error: null, folder: root ?? null, file: null, found: false, tag: null, listed: false,
    sergeant: null, worker: null, types: [], models: [], efforts: [...CLAUDE_EFFORTS],
    typeEfforts: [...CLAUDE_TYPE_EFFORTS], modelEfforts: {}, notes: [],
  };
  if (!root) return { ...base, error: CLAUDE_MESSAGES.noRoot };
  const state = readClaudeState(root);
  const out = { ...base, file: state.settings.file, found: state.settings.exists, tag: state.tag };
  if (state.settings.problem) return { ...out, error: CLAUDE_MESSAGES.unreadable };
  const settings = parseSettings(state.settings.text);
  if (!settings) return { ...out, error: CLAUDE_MESSAGES.unreadable };
  const model = valueLine(settings, 'model');
  const envBlock = settings.env === undefined ? {} : settings.env;
  out.ok = true;
  out.sergeant = { model, effort: effortLine(settings, model.value) };
  out.worker = { model: isPlainObject(envBlock) ? valueLine(envBlock, SUBAGENT_MODEL) : { value: null, set: true, editable: false }, effort: null };
  out.types = state.types.map(claudeTypeView);
  out.notes = overrideNotes(isPlainObject(envBlock) ? envBlock : {}, env);
  const set = [model.value, out.worker.model.value, ...out.types.map((t) => t.model?.value)];
  out.models = claudeChoices(seen, set);
  for (const m of out.models) {
    const effort = effortFor(settings, m.id);
    if (effort) out.modelEfforts[m.id] = effort;
  }
  return out;
}

function readClaudeState(root) {
  const settings = readFileText(path.join(root, 'settings.json'));
  const types = readTypes(path.join(root, 'agents'), '.md');
  const tag = tagOf([['settings.json', settings], ...types.map((t) => [`agents/${t.id}`, t])]);
  return { settings, types, tag };
}

// The settings object, {} for a file that is not there yet, or null when it is not a JSON object.
function parseSettings(text) {
  if (text === '') return {};
  try {
    const value = JSON.parse(stripBom(text));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A Line for a key that should hold a string.
function valueLine(obj, key) {
  if (!Object.hasOwn(obj, key)) return { value: null, set: false, editable: true };
  const value = obj[key];
  return typeof value === 'string' ? { value, set: true, editable: true } : { value: null, set: true, editable: false };
}

// The kind of Claude model a name is, from its short name: 'claude-opus-5-5' and 'opus[1m]' are
// both 'opus'. null for anything else.
function family(name) {
  const m = /(?:^|[^a-z])(fable|opus|sonnet|haiku)(?:[^a-z]|$)/.exec(String(name).toLowerCase());
  return m ? m[1] : null;
}

// The entries of modelSettings that hold the effort for `model`, as Claude Code reads them: its own
// entry and, for a short name such as opus, the entries of full names of the same kind, which
// /effort writes and which Claude Code puts first.
function effortKeys(table, model) {
  const keys = Object.hasOwn(table, model) ? [model] : [];
  if (!ALIAS_IDS.has(model)) return keys;
  const full = Object.keys(table).filter((k) => k !== model && !ALIAS_IDS.has(k) && family(k) === model);
  return [...full.sort().reverse(), ...keys];
}

function effortFor(settings, model) {
  if (!model || !isPlainObject(settings.modelSettings)) return null;
  const table = settings.modelSettings;
  for (const k of effortKeys(table, model)) {
    const level = isPlainObject(table[k]) ? table[k].effortLevel : undefined;
    if (typeof level === 'string') return level;
  }
  return null;
}

function effortLine(settings, model) {
  if (!model) return { value: null, set: false, editable: true };
  if (settings.modelSettings !== undefined && !isPlainObject(settings.modelSettings)) return { value: null, set: true, editable: false };
  const table = settings.modelSettings ?? {};
  const bad = effortKeys(table, model).some((k) => !isPlainObject(table[k]) || (table[k].effortLevel !== undefined && typeof table[k].effortLevel !== 'string'));
  const value = effortFor(settings, model);
  return { value, set: value !== null, editable: !bad };
}

function overrideNotes(envBlock, env) {
  const notes = [];
  for (const [name, text] of OVERRIDES) {
    const value = [envBlock[name], env?.[name]].find((v) => typeof v === 'string' && v.trim() && !/^(0|false|no|off)$/i.test(v.trim()));
    if (value) notes.push(text(plain(value, 60)));
  }
  return notes;
}

// The short names first, then the models the Claude Code sessions on the map use, then any other
// model a value names. Claude Code keeps no list of its own on this computer.
function claudeChoices(seen, set) {
  const out = new Map(CLAUDE_ALIASES.map(([id, label]) => [id, { id, label: `${label}, the newest`, efforts: null, defaultEffort: null, unlisted: false }]));
  for (const id of [...seen, ...set]) {
    if (typeof id !== 'string' || !CLAUDE_MODEL.test(id) || out.has(id) || out.size >= MAX_MODELS) continue;
    out.set(id, { id, label: modelLabel(id) || id, efforts: null, defaultEffort: null, unlisted: false });
  }
  return [...out.values()];
}

function claudeTypeView(t) {
  const out = { file: t.id, name: null, description: null, model: null, effort: null, pleni: false, error: null };
  if (t.problem) return { ...out, error: CLAUDE_MESSAGES.badFile };
  const block = scanFrontmatter(t.text);
  if (!block.ok) return { ...out, error: CLAUDE_MESSAGES.noBlock };
  const text = (key, max) => plain(frontmatterText(block.items, key).text, max);
  const line = (key) => {
    const now = frontmatterText(block.items, key);
    return { value: now.text, set: now.found, editable: now.editable };
  };
  return { ...out, name: text('name', 40), description: text('description', MAX_DESCRIPTION), model: line('model'), effort: line('effort') };
}

// Works out the new files for a Claude Code save. settings.json is read as JSON and written back with
// its own indent and line breaks, every other key kept. A sergeant's effort is kept for its model
// (modelSettings.<model>.effortLevel), where /effort keeps it. A worker has no effort of its own.
function planClaude(root, tag, changes) {
  if (!changes || typeof changes !== 'object') return refuse(400, MODELS_MESSAGES.nothing);
  const state = readClaudeState(root);
  if (typeof tag !== 'string' || tag !== state.tag) return refuse(409, CLAUDE_MESSAGES.changed);
  if (state.settings.problem) return refuse(409, CLAUDE_MESSAGES.unreadable);
  const settings = parseSettings(state.settings.text);
  if (!settings) return refuse(409, CLAUDE_MESSAGES.unreadable);
  const next = structuredClone(settings);
  const files = [];

  if (changes.sergeant !== undefined) {
    const want = changes.sergeant;
    if (!isPlainObject(want)) return refuse(400, MODELS_MESSAGES.nothing);
    if (Object.hasOwn(want, 'model')) {
      if (!claudeModelOk(want.model)) return refuse(400, CLAUDE_MESSAGES.badModel);
      if (!valueLine(next, 'model').editable) return refuse(409, CLAUDE_MESSAGES.notSimple('The model'));
      if (want.model === null) delete next.model;
      else next.model = want.model;
    }
    if (Object.hasOwn(want, 'effort')) {
      if (want.effort !== null && !CLAUDE_EFFORTS.includes(want.effort)) return refuse(400, CLAUDE_MESSAGES.badEffort);
      const model = typeof next.model === 'string' ? next.model : null;
      if (!model) {
        if (want.effort !== null) return refuse(400, CLAUDE_MESSAGES.needModel);
      } else if (!setClaudeEffort(next, model, want.effort)) {
        return refuse(409, CLAUDE_MESSAGES.notSimple('modelSettings'));
      }
    }
  }
  if (changes.worker !== undefined) {
    const want = changes.worker;
    if (!isPlainObject(want)) return refuse(400, MODELS_MESSAGES.nothing);
    if (Object.hasOwn(want, 'effort')) return refuse(400, CLAUDE_MESSAGES.noWorkerEffort);
    if (Object.hasOwn(want, 'model')) {
      if (!claudeModelOk(want.model)) return refuse(400, CLAUDE_MESSAGES.badModel);
      if (next.env !== undefined && !isPlainObject(next.env)) return refuse(409, CLAUDE_MESSAGES.notSimple('The env block'));
      const envBlock = next.env ?? {};
      if (!valueLine(envBlock, SUBAGENT_MODEL).editable) return refuse(409, CLAUDE_MESSAGES.notSimple(SUBAGENT_MODEL));
      if (want.model === null) delete envBlock[SUBAGENT_MODEL];
      else envBlock[SUBAGENT_MODEL] = want.model;
      if (Object.keys(envBlock).length) next.env = envBlock;
      else delete next.env;
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(settings)) {
    const text = settingsText(next, state.settings.text);
    if (JSON.stringify(parseSettings(text)) !== JSON.stringify(next)) return refuse(409, CLAUDE_MESSAGES.unreadable);
    files.push({ ...state.settings, next: text });
  }

  for (const want of Array.isArray(changes.types) ? changes.types : []) {
    const type = state.types.find((t) => want && t.id === want.file);
    if (!type) return refuse(404, MODELS_MESSAGES.badType);
    if (type.problem) return refuse(409, `${CLAUDE_MESSAGES.badFile} (${type.id})`);
    let text = type.text;
    for (const [what, check] of [['model', claudeModelOk], ['effort', (v) => v === null || CLAUDE_TYPE_EFFORTS.includes(v)]]) {
      if (!Object.hasOwn(want, what)) continue;
      if (!check(want[what])) return refuse(400, what === 'model' ? CLAUDE_MESSAGES.badModel : CLAUDE_MESSAGES.badEffort);
      const done = want[what] === null ? removeFrontmatterKey(text, what) : setFrontmatterValue(text, what, want[what]);
      if (!done.ok) return refuse(409, done.error === 'unreadable' ? CLAUDE_MESSAGES.noBlock : `The ${what} line of ${type.id} is written in a way Pleni does not change, so Pleni changed nothing. Change it in the file instead.`);
      text = done.text;
    }
    // Read it back: the new file must say exactly what was asked.
    const block = scanFrontmatter(text);
    if (!block.ok) return refuse(409, CLAUDE_MESSAGES.noBlock);
    for (const what of ['model', 'effort']) {
      if (!Object.hasOwn(want, what)) continue;
      const now = frontmatterText(block.items, what);
      if (want[what] === null ? now.found : now.text !== want[what]) return refuse(409, CLAUDE_MESSAGES.noBlock);
    }
    if (text !== type.text) files.push({ ...type, next: text });
  }

  if (changes.add !== undefined) {
    const add = newClaudeType(changes.add, state.types);
    if (!add.ok) return add;
    files.push({ file: path.join(root, 'agents', `${add.name}.md`), exists: false, text: '', bytes: null, next: add.text, create: true });
  }
  return { ok: true, files };
}

function claudeModelOk(value) {
  return value === null || (typeof value === 'string' && CLAUDE_MODEL.test(value));
}

// Sets (or, for null, takes out) the effort Claude Code keeps for `model`, in every entry it reads
// for it, and drops entries and a modelSettings left empty. false when an entry is not an object.
function setClaudeEffort(settings, model, effort) {
  if (settings.modelSettings !== undefined && !isPlainObject(settings.modelSettings)) return false;
  const table = settings.modelSettings ?? {};
  const keys = effortKeys(table, model).filter((k) => k === model || (isPlainObject(table[k]) && table[k].effortLevel !== undefined));
  if (effort !== null && !keys.includes(model)) keys.push(model);
  for (const k of keys) {
    if (table[k] !== undefined && !isPlainObject(table[k])) return false;
    const entry = table[k] ?? {};
    if (effort === null) delete entry.effortLevel;
    else entry.effortLevel = effort;
    if (Object.keys(entry).length) table[k] = entry;
    else delete table[k];
  }
  if (Object.keys(table).length) settings.modelSettings = table;
  else delete settings.modelSettings;
  return true;
}

// settings.json as Claude Code writes it, with the old file's indent, line breaks, BOM and last line
// break.
function settingsText(obj, before) {
  const indent = /\n([ \t]+)"/.exec(before)?.[1] ?? '  ';
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const bom = before.charCodeAt(0) === 0xfeff ? String.fromCharCode(0xfeff) : '';
  const end = before === '' || /\n$/.test(before) ? eol : '';
  return `${bom}${JSON.stringify(obj, null, indent).replace(/\n/g, eol)}${end}`;
}

// A new agent file: the settings block Claude Code needs (name and description), the model when
// given, and a short instruction below it.
function newClaudeType(raw, types) {
  if (!raw || typeof raw !== 'object') return refuse(400, MODELS_MESSAGES.badName);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!TYPE_NAME.test(name)) return refuse(400, MODELS_MESSAGES.badName);
  if (CLAUDE_BUILT_IN.has(name)) return refuse(400, CLAUDE_MESSAGES.builtInName);
  if (WINDOWS_DEVICE.test(name)) return refuse(400, MODELS_MESSAGES.deviceName);
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (!description || Array.from(description).length > MAX_DESCRIPTION || /\p{Cc}/u.test(description)) return refuse(400, MODELS_MESSAGES.badDescription);
  const model = raw.model ?? null;
  if (!claudeModelOk(model)) return refuse(400, CLAUDE_MESSAGES.badModel);
  const taken = types.some((t) => t.id.toLowerCase() === `${name}.md` || claudeTypeName(t) === name);
  if (taken) return refuse(409, MODELS_MESSAGES.takenName);
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${yamlValue(description)}`,
    ...(model ? [`model: ${yamlValue(model)}`] : []),
    '---',
    '',
    'Do the task you were given. When you finish, say what you did and what is left to do.',
    '',
  ];
  return { ok: true, name, text: lines.join('\n') };
}

function claudeTypeName(t) {
  if (!t.text) return null;
  const block = scanFrontmatter(t.text);
  return block.ok ? frontmatterText(block.items, 'name').text?.trim() ?? null : null;
}

// Copies each old file into Pleni's folder, then writes each new one next to it and renames it
// into place, but only while the file still holds what Pleni read.
function writePlan(files, backupDir, t, app) {
  const backups = [];
  const written = [];
  try {
    for (const f of files) {
      if (f.exists && f.bytes) backups.push(backup(backupDir, f.file, f.bytes, t, app));
    }
    for (const f of files) {
      const still = readFileText(f.file);
      const same = f.create ? !still.exists : still.exists === f.exists && (still.bytes ?? Buffer.alloc(0)).equals(f.bytes ?? Buffer.alloc(0));
      if (!same) return refuse(409, f.create ? MODELS_MESSAGES.takenName : app === 'claude' ? CLAUDE_MESSAGES.changed : MODELS_MESSAGES.changed, written);
      writeAtomic(f.file, f.next, f.create);
      written.push(f.file);
    }
  } catch {
    return refuse(500, MODELS_MESSAGES.failed, written);
  }
  return { ok: true, files: written, backups };
}

function writeAtomic(file, text, create) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  if (create) {
    fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' });
    return;
  }
  const temp = path.join(dir, `.${path.basename(file)}.pleni-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(temp, 'wx');
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(temp, file);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Keep the first error.
    }
    throw err;
  }
}

// <backupDir>/<app>-<file name>-<yyyyMMdd-HHmmss><ext>, keeping the newest KEEP_BACKUPS of each.
function backup(backupDir, file, bytes, t, app) {
  fs.mkdirSync(backupDir, { recursive: true });
  const ext = path.extname(file).replace(/[^A-Za-z0-9.]/g, '');
  const label = `${app}-${path.basename(file, path.extname(file)).replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const stamp = timeStamp(t);
  let target = path.join(backupDir, `${label}-${stamp}${ext}`);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(backupDir, `${label}-${stamp}-${n}${ext}`);
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  prune(backupDir, label, ext);
  return target;
}

function prune(dir, label, ext) {
  const mine = new RegExp(`^${label}-\\d{8}-\\d{6}(-\\d+)?${ext.replace('.', '\\.')}$`);
  const old = fs.readdirSync(dir).filter((n) => mine.test(n)).sort().reverse().slice(KEEP_BACKUPS);
  for (const name of old) fs.rmSync(path.join(dir, name), { force: true });
}

function timeStamp(t) {
  const d = new Date(t);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

function refuse(status, error, files = []) {
  return { ok: false, status, error, files };
}
