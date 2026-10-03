import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function load(react = { createElement: (type, props, ...children) => ({ type, props, children }) }) {
  let declaration;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: entry => { declaration = entry; } } } });
  const requested = [];
  const api = declaration.factory(name => {
    requested.push(name);
    assert.equal(name, 'react', 'Only platform React may be required');
    return react;
  });
  return { declaration, api, requested };
}
function mockForm(options = {}) {
  let snapshot = {
    status: 'ready', writable: true, revision: 4,
    value: { errorCodes: ['upstream_stream_read_error', 'stream_timeout', 'stream error'], providers: [], untouched: 'keep' },
    base: { errorCodes: ['base-code'], providers: [] }, user: {}, ...options,
  };
  const listeners = new Set();
  const calls = [];
  let behavior;
  const form = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async mutate(operations, revision) {
      calls.push({ operations: plain(operations), revision });
      if (behavior) return behavior(operations, revision);
      if (revision !== snapshot.revision) return false;
      const value = { ...snapshot.value };
      for (const op of operations) value[op.path[0]] = op.op === 'set' ? plain(op.value) : snapshot.base[op.path[0]];
      update({ value, revision: snapshot.revision + 1 });
      return true;
    },
  };
  function update(patch) { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); }
  return { form, calls, update, listeners, setBehavior(fn) { behavior = fn; } };
}
function started(mock = mockForm()) {
  const { api } = load();
  const editor = api.createEditor(mock.form);
  const stop = editor.start();
  return { mock, editor, stop };
}

test('browser bundle asks only platform React and preserves multiword identifiers', () => {
  const { declaration, api, requested } = load();
  assert.equal(declaration.id, 'dsh-stream-retry');
  assert.deepEqual(requested, ['react']);
  assert.deepEqual(plain(api.inject), ['slots', 'configForms']);
  assert.deepEqual(plain(api.parseList(' stream error\r\n\ncustom_CODE\n')), ['stream error', 'custom_CODE']);
});
test('registers exact Configure slot/key with public services and releases lifetime', () => {
  const { api } = load();
  const { form } = mockForm();
  let registration;
  let disposed = 0;
  const effects = [];
  const ctx = {
    configForms: {
      get(id) { assert.equal(id, 'stream-retry'); return form; },
      whileServed(ids, register) { assert.deepEqual(plain(ids), ['stream-retry']); return register(); },
    },
    slots: {
      inject(name, register) { assert.equal(name, 'plugins.row.config'); return register(); },
      register(spec, component) { registration = { spec, component }; return () => { disposed++; }; },
    },
    effect(make) { effects.push(make()); },
  };
  api.apply(ctx);
  assert.equal(registration.spec.name, 'plugins.row.config');
  assert.equal(registration.spec.key, 'dsh-stream-retry#stream-retry');
  assert.equal(registration.spec.inject().configForm, form);
  assert.match(registration.component({ view: 'summary' }), /DSH/);
  effects.forEach(dispose => dispose());
  assert.equal(disposed, 1);
});
test('stages locally and saves both fields atomically with baseline revision', async () => {
  const { mock, editor, stop } = started();
  editor.edit('errorCodes', 'stream error\ncustom');
  editor.edit('providers', 'route-a\nroute-b');
  assert.equal(mock.calls.length, 0);
  assert.equal(await editor.save(), true);
  assert.deepEqual(mock.calls, [{ revision: 4, operations: [
    { op: 'set', path: ['errorCodes'], value: ['stream error', 'custom'] },
    { op: 'set', path: ['providers'], value: ['route-a', 'route-b'] },
  ] }]);
  assert.equal(mock.form.getSnapshot().value.untouched, 'keep');
  assert.equal(editor.getSnapshot().dirty, false);
  stop();
});
test('blank lists save explicit empty arrays instead of resetting defaults', async () => {
  const { mock, editor } = started();
  editor.edit('errorCodes', '   \n');
  await editor.save();
  assert.deepEqual(mock.calls[0].operations.map(op => op.value), [[], []]);
});
test('resets stage inherited values and save unset operations, no early write', async () => {
  const { mock, editor } = started();
  editor.reset();
  assert.equal(editor.getSnapshot().errorCodes, 'base-code');
  assert.equal(mock.calls.length, 0);
  await editor.save();
  assert.deepEqual(mock.calls[0].operations, [
    { op: 'unset', path: ['errorCodes'] }, { op: 'unset', path: ['providers'] },
  ]);
});
test('editing a reset field sets that field while the other remains unset', async () => {
  const { mock, editor } = started();
  editor.reset();
  editor.edit('errorCodes', 'custom');
  await editor.save();
  assert.deepEqual(mock.calls[0].operations, [
    { op: 'set', path: ['errorCodes'], value: ['custom'] }, { op: 'unset', path: ['providers'] },
  ]);
});
test('remote updates refresh pristine state, but never overwrite drafts', async () => {
  const { mock, editor } = started();
  mock.update({ revision: 5, value: { errorCodes: ['remote'], providers: ['remote-route'] } });
  assert.equal(editor.getSnapshot().errorCodes, 'remote');
  editor.edit('errorCodes', 'local draft');
  mock.update({ revision: 6, value: { errorCodes: ['newer'], providers: [] } });
  assert.equal(editor.getSnapshot().errorCodes, 'local draft');
  assert.equal(editor.getSnapshot().conflict, true);
  assert.equal(await editor.save(), false);
  assert.equal(mock.calls.length, 0);
  editor.discard();
  assert.equal(editor.getSnapshot().errorCodes, 'newer');
  assert.equal(editor.getSnapshot().dirty, false);
});
test('refused writes preserve drafts; transport failures do not leak raw diagnostics', async () => {
  const { mock, editor } = started();
  editor.edit('errorCodes', 'custom');
  mock.setBehavior(async () => false);
  assert.equal(await editor.save(), false);
  assert.equal(editor.getSnapshot().errorCodes, 'custom');
  assert.equal(editor.getSnapshot().dirty, true);
  assert.equal(editor.getSnapshot().saving, false);
  mock.setBehavior(async () => { throw new Error('SENSITIVE_DIAGNOSTIC'); });
  assert.equal(await editor.save(), false);
  assert.doesNotMatch(editor.getSnapshot().error, /SENSITIVE/);
  assert.equal(editor.getSnapshot().dirty, true);
});
test('prevents duplicate saves and edits during an in-flight write', async () => {
  const { mock, editor } = started();
  let resolve;
  mock.setBehavior(() => new Promise(done => { resolve = done; }));
  editor.edit('errorCodes', 'custom');
  const saving = editor.save();
  editor.edit('errorCodes', 'ignored');
  assert.equal(editor.getSnapshot().errorCodes, 'custom');
  assert.equal(await editor.save(), false);
  assert.equal(mock.calls.length, 1);
  resolve(false);
  await saving;
});
test('read-only, unavailable, and missing-revision states never write', async () => {
  for (const patch of [{ writable: false }, { status: 'unavailable' }, { revision: undefined }]) {
    const { mock, editor } = started(mockForm(patch));
    editor.edit('errorCodes', 'custom');
    assert.equal(await editor.save(), false);
    assert.equal(mock.calls.length, 0);
  }
});
test('unmount cleanup removes service subscription and ignores late mutation settlement', async () => {
  const { mock, editor, stop } = started();
  let resolve;
  mock.setBehavior(() => new Promise(done => { resolve = done; }));
  editor.edit('errorCodes', 'custom');
  const saving = editor.save();
  const before = editor.getSnapshot();
  stop();
  assert.equal(mock.listeners.size, 0);
  resolve(false);
  await saving;
  assert.equal(editor.getSnapshot(), before);
});
test('raw React page includes exactly the two accessible list editors', () => {
  const effects = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: init => [init()],
    useEffect: effect => { effects.push(effect()); },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  const { api } = load(react);
  const { form } = mockForm();
  let view;
  api.apply({ configForms: { get: () => form, whileServed: (_ids, register) => register() },
    slots: { inject: (_name, register) => register(), register: (_spec, component) => { view = component; return () => {}; } },
    effect: make => effects.push(make()),
  });
  const mounted = view({ view: 'page', configForm: form });
  const tree = mounted.type(mounted.props);
  function collect(node, type) {
    if (!node || typeof node !== 'object') return [];
    return [...(node.type === type ? [node] : []), ...(node.children ?? []).flat(Infinity).flatMap(child => collect(child, type))];
  }
  const areas = collect(tree, 'textarea');
  assert.equal(areas.length, 2);
  assert.deepEqual(areas.map(area => area.props.id), ['dsh-stream-retry-errorCodes', 'dsh-stream-retry-providers']);
  assert.equal(collect(tree, 'label').length, 2);
  assert.equal(collect(tree, 'button').length, 3);
  assert.match(areas[0].props.value, /stream error/);
  effects.forEach(dispose => dispose?.());
});
