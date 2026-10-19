import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EFFORTS, MODELS_MESSAGES, PLENI_MARK, createModelSaver, modelChoices, readCatalog, readCodexModels } from '../src/models.js';

const CONFIG = [
  '# My Codex settings',
  'model = "gpt-6-astra"',
  'model_reasoning_effort = "max"',
  'approval_policy = "on-request"',
  '',
  '[mcp_servers.docs]',
  'command = "npx"',
  '',
  '[agents]',
  'max_threads = 6',
  '',
].join('\n');

function codexFolder(t, { config = CONFIG, types = {}, catalog = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (config !== null) fs.writeFileSync(path.join(root, 'config.toml'), config);
  if (Object.keys(types).length) fs.mkdirSync(path.join(root, 'agents'));
  for (const [name, text] of Object.entries(types)) fs.writeFileSync(path.join(root, 'agents', name), text);
  if (catalog) fs.writeFileSync(path.join(root, 'models_cache.json'), JSON.stringify(catalog));
  const backups = path.join(root, 'pleni-backups');
  return { root, backups, read: (name = 'config.toml') => fs.readFileSync(path.join(root, name), 'utf8') };
}

const CODER = 'name = "coder"\ndescription = "Coding and design work."\nmodel = "gpt-6-astra"\ndeveloper_instructions = """\nWrite code.\n"""\n';

test('readCodexModels shows the sergeant and worker lines, the worker types and the choices', (t) => {
  const { root } = codexFolder(t, { types: { 'coder.toml': CODER, 'notes.txt': 'not a type' } });
  const m = readCodexModels({ root, seen: ['gpt-6.1-sol', 'gpt-6-astra'] });
  assert.equal(m.ok, true);
  assert.equal(m.error, null);
  assert.equal(m.found, true);
  assert.equal(m.file, path.join(root, 'config.toml'));
  assert.match(m.tag, /^[0-9a-f]{24}$/);
  assert.deepEqual(m.sergeant, { model: { value: 'gpt-6-astra', set: true, editable: true }, effort: { value: 'max', set: true, editable: true } });
  assert.deepEqual(m.worker, { model: { value: null, set: false, editable: true }, effort: { value: null, set: false, editable: true } });
  assert.equal(m.types.length, 1);
  assert.deepEqual(m.types[0], {
    file: 'coder.toml',
    name: 'coder',
    description: 'Coding and design work.',
    model: { value: 'gpt-6-astra', set: true, editable: true },
    effort: { value: null, set: false, editable: true },
    pleni: false,
    error: null,
  });
  assert.deepEqual(m.models.map((x) => [x.id, x.label]), [['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-6-astra', 'GPT-6 Astra']]);
  assert.deepEqual(m.efforts, EFFORTS);
});

test('readCodexModels works before Codex has a settings file, and says when it cannot read one', (t) => {
  const none = codexFolder(t, { config: null });
  const fresh = readCodexModels({ root: none.root, seen: [] });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.found, false);
  assert.deepEqual(fresh.sergeant.model, { value: null, set: false, editable: true });
  const broken = codexFolder(t, { config: 'model = "never closed\n' });
  const bad = readCodexModels({ root: broken.root, seen: [] });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, MODELS_MESSAGES.unreadable);
  assert.equal(readCodexModels({ root: null }).error, MODELS_MESSAGES.noRoot);
});

// A trimmed models_cache.json, in the shape Codex keeps it.
const CATALOG = {
  fetched_at: '2026-10-19T00:00:00Z',
  client_version: '1.0.0',
  identity: 'not shown',
  models: [
    { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', visibility: 'list', priority: 2, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }] },
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list', priority: 1, default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }, { effort: 'turbo' }] },
    { slug: 'gpt-6.1-luna', display_name: 'GPT-6.1 Luna', visibility: 'list', priority: 3, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'hide', priority: 13, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }] },
    { slug: 'bad name!', visibility: 'list' },
  ],
};

test("Codex's own model list comes first, in its order, with the effort levels each model takes", (t) => {
  const { root } = codexFolder(t, { catalog: CATALOG });
  const catalog = readCatalog(root);
  assert.deepEqual(catalog.map((m) => [m.id, m.label, m.hidden]), [
    ['gpt-6.1-sol', 'GPT-6.1 Sol', false],
    ['gpt-6-astra', 'GPT-6 Astra', false],
    ['gpt-6.1-luna', 'GPT-6.1 Luna', false],
    ['gpt-5.5', 'GPT-5.5', true],
  ]);
  assert.deepEqual(catalog[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'turbo']);
  assert.equal(catalog[0].defaultEffort, 'medium');
  const m = readCodexModels({ root, seen: ['gpt-5-luna'] });
  assert.equal(m.listed, true);
  // The list leaves out the hidden model and the models in use; a model a line names stays.
  assert.deepEqual(m.models.map((x) => [x.id, x.unlisted]), [['gpt-6.1-sol', false], ['gpt-6-astra', false], ['gpt-6.1-luna', false]]);
  assert.deepEqual(m.efforts, [...EFFORTS, 'turbo']);
  assert.deepEqual(modelChoices(catalog, [], ['gpt-5.5', 'gpt-4-old']).slice(3).map((x) => [x.id, x.unlisted]), [['gpt-5.5', false], ['gpt-4-old', true]]);
  // Without Codex's list: the models in use, then what the lines name.
  assert.deepEqual(modelChoices([], ['x y', 'gpt-6-astra', 'gpt-6-astra'], [null, 'gpt-7']), [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: null, defaultEffort: null, unlisted: false },
    { id: 'gpt-7', label: 'GPT-7', efforts: null, defaultEffort: null, unlisted: false },
  ]);
  const half = codexFolder(t);
  fs.writeFileSync(path.join(half.root, 'models_cache.json'), '{"models": [');
  assert.deepEqual(readCatalog(half.root), [], 'a list Codex is writing right now counts as none');
});

test('with Codex\'s list, saving takes only the models it lists and the effort levels each takes', (t) => {
  const typed = 'name = "coder"\ndescription = "Code."\nmodel = "gpt-6.1-luna"\ndeveloper_instructions = "x"\n';
  const { root, backups, read } = codexFolder(t, { catalog: CATALOG, types: { 'coder.toml': typed } });
  const saver = createModelSaver();
  const tryIt = (changes) => saver.save({ root, backupDir: backups, tag: readCodexModels({ root, seen: [] }).tag, changes });
  assert.equal(tryIt({ sergeant: { model: 'gpt-9-dream' } }).error, MODELS_MESSAGES.unknownModel);
  assert.equal(tryIt({ worker: { model: 'gpt-9-dream' } }).error, MODELS_MESSAGES.unknownModel);
  assert.equal(tryIt({ add: { name: 'dreamer', description: 'Dreams.', model: 'gpt-9-dream' } }).error, MODELS_MESSAGES.unknownModel);
  // The file says max now, which Luna does not take.
  assert.equal(tryIt({ sergeant: { model: 'gpt-6.1-luna' } }).error, 'GPT-6.1 Luna does not take max effort. Pick another effort level.');
  assert.equal(tryIt({ worker: { model: 'gpt-6.1-luna', effort: 'xhigh' } }).error, 'GPT-6.1 Luna does not take extra high effort. Pick another effort level.');
  assert.equal(tryIt({ types: [{ file: 'coder.toml', effort: 'high' }] }).error, 'GPT-6.1 Luna does not take high effort. Pick another effort level.');
  assert.equal(read(), CONFIG);
  // A model Codex hides from its picker still starts agents, so it may be saved.
  assert.equal(tryIt({ sergeant: { model: 'gpt-5.5', effort: 'xhigh' } }).ok, true);
  assert.ok(read().includes('model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n'));
  assert.equal(tryIt({ sergeant: { model: 'gpt-6.1-sol', effort: 'turbo' } }).ok, true);
});

test('worker types in folders inside the agents folder are listed, and their names are kept apart', (t) => {
  const { root, backups } = codexFolder(t, { types: { 'coder.toml': 'name = "coder"\ndescription = "Code."\ndeveloper_instructions = "x"\n' } });
  fs.mkdirSync(path.join(root, 'agents', 'team'));
  fs.writeFileSync(path.join(root, 'agents', 'team', 'writer.toml'), 'name = "scribe"\ndescription = "Write."\nmodel = "gpt-6.1-sol"\ndeveloper_instructions = "x"\n');
  const m = readCodexModels({ root, seen: [] });
  assert.deepEqual(m.types.map((x) => [x.file, x.name]), [['coder.toml', 'coder'], ['team/writer.toml', 'scribe']]);
  const saver = createModelSaver();
  const add = (name) => saver.save({ root, backupDir: backups, tag: readCodexModels({ root, seen: [] }).tag, changes: { add: { name, description: 'Again.', model: null } } });
  assert.equal(add('scribe').error, MODELS_MESSAGES.takenName);
  for (const name of ['default', 'worker', 'explorer']) assert.equal(add(name).error, MODELS_MESSAGES.builtInName);
  const changed = saver.save({ root, backupDir: backups, tag: m.tag, changes: { types: [{ file: 'team/writer.toml', model: 'gpt-6-astra' }] } });
  assert.equal(changed.ok, true, changed.error);
  assert.ok(fs.readFileSync(path.join(root, 'agents', 'team', 'writer.toml'), 'utf8').includes('model = "gpt-6-astra"'));
  assert.equal(saver.save({ root, backupDir: backups, tag: readCodexModels({ root, seen: [] }).tag, changes: { types: [{ file: '../config.toml', model: 'x' }] } }).error, MODELS_MESSAGES.badType);
});

test('saving changes only the model lines, after a copy of the old file', (t) => {
  const { root, backups, read } = codexFolder(t);
  const saver = createModelSaver({ now: () => Date.UTC(2026, 9, 19, 12, 0, 0) });
  const { tag } = readCodexModels({ root, seen: [] });
  const done = saver.save({
    root,
    backupDir: backups,
    tag,
    changes: { sergeant: { model: 'gpt-6.1-sol', effort: 'high' }, worker: { model: 'gpt-6-astra', effort: null } },
  });
  assert.equal(done.ok, true, done.error);
  assert.deepEqual(done.files, [path.join(root, 'config.toml')]);
  assert.equal(
    read(),
    CONFIG.replace('model = "gpt-6-astra"', 'model = "gpt-6.1-sol"')
      .replace('model_reasoning_effort = "max"', 'model_reasoning_effort = "high"')
      .replace('[agents]\n', '[agents]\ndefault_subagent_model = "gpt-6-astra"\n'),
  );
  assert.equal(done.backups.length, 1);
  assert.equal(path.dirname(done.backups[0]), backups);
  assert.match(path.basename(done.backups[0]), /^codex-config-\d{8}-\d{6}\.toml$/);
  assert.equal(fs.readFileSync(done.backups[0], 'utf8'), CONFIG);
  // No stray temp files are left next to it.
  assert.deepEqual(fs.readdirSync(root).sort(), ['config.toml', 'pleni-backups']);
  const after = readCodexModels({ root, seen: [] });
  assert.equal(after.sergeant.model.value, 'gpt-6.1-sol');
  assert.equal(after.worker.model.value, 'gpt-6-astra');
  assert.notEqual(after.tag, tag);
});

test('saving stops when the files changed since the page looked', (t) => {
  const { root, backups, read } = codexFolder(t);
  const saver = createModelSaver();
  const { tag } = readCodexModels({ root, seen: [] });
  fs.appendFileSync(path.join(root, 'config.toml'), 'notify = ["x"]\n');
  const done = saver.save({ root, backupDir: backups, tag, changes: { sergeant: { model: 'gpt-6.1-sol' } } });
  assert.deepEqual([done.ok, done.status, done.error], [false, 409, MODELS_MESSAGES.changed]);
  assert.ok(read().includes('model = "gpt-6-astra"'));
  assert.equal(fs.existsSync(backups), false);
});

test('saving checks every value before it writes anything', (t) => {
  const { root, backups, read } = codexFolder(t);
  const saver = createModelSaver();
  const { tag } = readCodexModels({ root, seen: [] });
  const tryIt = (changes) => saver.save({ root, backupDir: backups, tag, changes });
  assert.equal(tryIt({ sergeant: { model: 'gpt "6"' } }).error, MODELS_MESSAGES.badModel);
  assert.equal(tryIt({ sergeant: { model: 'gpt-6.1-sol', effort: 'enormous' } }).error, MODELS_MESSAGES.badEffort);
  assert.equal(tryIt({ types: [{ file: 'nope.toml', model: 'x' }] }).error, MODELS_MESSAGES.badType);
  assert.equal(read(), CONFIG);
  assert.deepEqual(tryIt({}), { ok: true, files: [], backups: [] });
  assert.equal(fs.existsSync(backups), false);
});

test('saving will not touch a line written in a way Pleni does not change', (t) => {
  const config = 'model = "gpt-6-astra"\nagents = { max_threads = 2 }\n';
  const { root, backups, read } = codexFolder(t, { config });
  const { tag } = readCodexModels({ root, seen: [] });
  const done = createModelSaver().save({ root, backupDir: backups, tag, changes: { sergeant: { model: 'gpt-6.1-sol' }, worker: { model: 'gpt-6-astra' } } });
  assert.equal(done.ok, false);
  assert.equal(done.status, 409);
  assert.match(done.error, /default_subagent_model under \[agents\] is written another way/);
  assert.equal(read(), config);
});

test('a worker type gets a new model, and its effort line can go so the sergeant chooses', (t) => {
  const typed = CODER.replace('model = "gpt-6-astra"\n', 'model = "gpt-6-astra"\nmodel_reasoning_effort = "low"\n');
  const { root, backups, read } = codexFolder(t, { types: { 'coder.toml': typed } });
  const { tag } = readCodexModels({ root, seen: [] });
  const done = createModelSaver().save({ root, backupDir: backups, tag, changes: { types: [{ file: 'coder.toml', model: 'gpt-7-astra', effort: null }] } });
  assert.equal(done.ok, true, done.error);
  assert.equal(read('agents/coder.toml'), CODER.replace('gpt-6-astra', 'gpt-7-astra'));
  assert.match(path.basename(done.backups[0]), /^codex-coder-\d{8}-\d{6}\.toml$/);
  assert.equal(read(), CONFIG);
});

test('a new worker type is a new file that never replaces one', (t) => {
  const { root, backups, read } = codexFolder(t, { types: { 'coder.toml': CODER } });
  const saver = createModelSaver();
  const { tag } = readCodexModels({ root, seen: [] });
  const add = (a) => saver.save({ root, backupDir: backups, tag, changes: { add: a } });
  assert.equal(add({ name: 'Helper', description: 'x', model: 'gpt-6.1-sol' }).error, MODELS_MESSAGES.badName);
  assert.equal(add({ name: 'helper', description: '', model: 'gpt-6.1-sol' }).error, MODELS_MESSAGES.badDescription);
  assert.equal(add({ name: 'coder', description: 'Again', model: 'gpt-6.1-sol' }).error, MODELS_MESSAGES.takenName);
  assert.equal(add({ name: 'nul', description: 'A device on Windows', model: null }).error, MODELS_MESSAGES.deviceName);
  assert.equal(add({ name: 'com1', description: 'A device on Windows', model: null }).error, MODELS_MESSAGES.deviceName);
  const done = add({ name: 'helper', description: 'Easier tasks: small fixes, checks and notes.', model: 'gpt-6.1-sol' });
  assert.equal(done.ok, true, done.error);
  assert.deepEqual(done.backups, []);
  const text = read('agents/helper.toml');
  assert.ok(text.startsWith(PLENI_MARK));
  assert.ok(text.includes('name = "helper"\ndescription = "Easier tasks: small fixes, checks and notes."\nmodel = "gpt-6.1-sol"\ndeveloper_instructions = """\n'));
  const view = readCodexModels({ root, seen: [] }).types.find((x) => x.file === 'helper.toml');
  assert.deepEqual([view.name, view.model.value, view.effort.set, view.pleni], ['helper', 'gpt-6.1-sol', false, true]);
});

test('saving keeps CRLF line breaks, and only the newest copies are kept', (t) => {
  const crlf = CONFIG.replace(/\n/g, '\r\n');
  const { root, backups, read } = codexFolder(t, { config: crlf });
  let clock = Date.UTC(2026, 9, 19, 12, 0, 0);
  const saver = createModelSaver({ now: () => clock });
  for (let i = 0; i < 23; i++) {
    clock += 61 * 1000;
    const { tag } = readCodexModels({ root, seen: [] });
    const done = saver.save({ root, backupDir: backups, tag, changes: { sergeant: { effort: i % 2 ? 'medium' : 'high' } } });
    assert.equal(done.ok, true, done.error);
  }
  assert.ok(read().includes('\r\nmodel_reasoning_effort = "high"\r\n'));
  assert.equal(read().replace('"high"', '"max"'), crlf);
  assert.equal(fs.readdirSync(backups).length, 20);
});

test('saving stops after a few saves in a minute', (t) => {
  const { root, backups } = codexFolder(t);
  const saver = createModelSaver({ now: () => 1000 });
  let last;
  for (let i = 0; i < 11; i++) {
    const { tag } = readCodexModels({ root, seen: [] });
    last = saver.save({ root, backupDir: backups, tag, changes: { sergeant: { effort: i % 2 ? 'high' : 'low' } } });
  }
  assert.deepEqual([last.ok, last.status, last.error], [false, 429, MODELS_MESSAGES.tooMany]);
});

test('a settings file that is not plain UTF-8 text is never changed', (t) => {
  const { root, backups } = codexFolder(t, { config: null });
  const bytes = Buffer.concat([Buffer.from('model = "a'), Buffer.from([0xff, 0xfe]), Buffer.from('"\n')]);
  fs.writeFileSync(path.join(root, 'config.toml'), bytes);
  const m = readCodexModels({ root, seen: [] });
  assert.equal(m.ok, false);
  assert.equal(m.error, MODELS_MESSAGES.notText);
  const done = createModelSaver().save({ root, backupDir: backups, tag: m.tag, changes: { sergeant: { model: 'x' } } });
  assert.equal(done.ok, false);
  assert.ok(fs.readFileSync(path.join(root, 'config.toml')).equals(bytes));
});
