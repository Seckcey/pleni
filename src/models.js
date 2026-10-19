// The Models page: which model and effort Codex agents start with. Pleni reads them from Codex's own
// settings file (config.toml), the worker types in its agents folder, and the list of models Codex
// keeps for the account (models_cache.json). With settings.models.edit on, the person can change
// them from the page on this computer. Pleni then changes only those lines (src/toml.js keeps every
// other byte), after it saves a copy of each file in its own folder. It never writes a file it could
// not read back, it stops when Codex changed a file since the page looked, and it offers only models
// and effort levels that Codex lists, because Codex refuses to start a worker with any other.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { renameWithRetry } from './config.js';
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
const TYPE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.toml$/;
const TYPE_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
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
// It runs from start to end without waiting, so two saves never mix.
export function createModelSaver({ now = Date.now } = {}) {
  const times = [];

  function save({ root, backupDir, tag, changes }) {
    if (!root) return refuse(409, MODELS_MESSAGES.noRoot);
    const t = now();
    while (times.length && t - times[0] >= MINUTE_MS) times.shift();
    if (times.length >= SAVES_PER_MINUTE) return refuse(429, MODELS_MESSAGES.tooMany);
    const plan = planChanges(root, tag, changes);
    if (!plan.ok) return plan;
    if (!plan.files.length) return { ok: true, files: [], backups: [] };
    times.push(t);
    return writePlan(plan.files, backupDir, t);
  }

  return { save };
}

// ---- reading ----

function readState(root) {
  const config = readFileText(path.join(root, 'config.toml'));
  const types = readTypes(path.join(root, 'agents'));
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

// The worker type files: every .toml file in the agents folder and the folders in it, as Codex reads
// them. `id` is the path inside the agents folder, with "/" between folders.
function readTypes(dir) {
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
      if (d.isFile() && TYPE_FILE.test(d.name)) {
        const id = [...parts, d.name].join('/');
        out.push({ id, ...readFileText(path.join(folder, d.name)) });
      } else if (d.isDirectory() && TYPE_DIR.test(d.name) && parts.length + 1 < TYPE_DEPTH) {
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

// Copies each old file into Pleni's folder, then writes each new one next to it and renames it
// into place, but only while the file still holds what Pleni read.
function writePlan(files, backupDir, t) {
  const backups = [];
  const written = [];
  try {
    for (const f of files) {
      if (f.exists && f.bytes) backups.push(backup(backupDir, f.file, f.bytes, t));
    }
    for (const f of files) {
      const still = readFileText(f.file);
      const same = f.create ? !still.exists : still.exists === f.exists && (still.bytes ?? Buffer.alloc(0)).equals(f.bytes ?? Buffer.alloc(0));
      if (!same) return refuse(409, f.create ? MODELS_MESSAGES.takenName : MODELS_MESSAGES.changed, written);
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

// <backupDir>/codex-<file name>-<yyyyMMdd-HHmmss>.toml, keeping the newest KEEP_BACKUPS of each.
function backup(backupDir, file, bytes, t) {
  fs.mkdirSync(backupDir, { recursive: true });
  const label = `codex-${path.basename(file, '.toml').replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const stamp = timeStamp(t);
  let target = path.join(backupDir, `${label}-${stamp}.toml`);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(backupDir, `${label}-${stamp}-${n}.toml`);
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  prune(backupDir, label);
  return target;
}

function prune(dir, label) {
  const mine = new RegExp(`^${label}-\\d{8}-\\d{6}(-\\d+)?\\.toml$`);
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
