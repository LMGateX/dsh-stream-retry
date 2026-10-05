/**
 * Settings-page protocol tests. They import the built browser bundle and drive its
 * exported editor against a mock of the public settings/slot services.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConfigForm, ConfigFormSnapshot, PathOperation } from '../client/public.js';

/** Minimal module-loader facade: capture the single registered factory. */
interface LoadedClient {
  id: string;
  factory(require: (name: string) => unknown): ClientApi;
}
type ClientApi = {
  inject: string[];
  apply(ctx: unknown): void;
  parseList(text: string): string[];
  summary: string;
  createEditor(form: ConfigForm): Editor;
};
type Editor = {
  getSnapshot(): EditorState;
  subscribe(listener: () => void): () => void;
  start(): () => void;
  edit(field: string, text: string): void;
  reset(): void;
  discard(): void;
  save(): Promise<boolean>;
};
type EditorState = {
  status: string; writable: boolean; revision: number | undefined;
  errorCodes: string; providers: string;
  dirty: boolean; saving: boolean; error: string; conflict: boolean;
};

const registry: { entry?: LoadedClient } = {};
Reflect.set(globalThis, 'window', {
  __ModuleLoader__: { load: (entry: LoadedClient) => { registry.entry = entry; } },
});
const bundle = (await import('../client/client.js')) as unknown as ClientApi;
const entry = registry.entry;
assert(entry, 'the bundle must register exactly one loader entry');

/** Load the client API with a stubbed React runtime. */
function load(react?: Record<string, unknown>): { api: ClientApi; requested: string[] } {
  const requested: string[] = [];
  const api = entry!.factory((name) => {
    requested.push(name);
    assert.equal(name, 'react', 'Only platform React may be required');
    return react ?? { createElement: () => null };
  });
  return { api, requested };
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A configurable stand-in for the Host settings form. */
function mockForm(overrides: Omit<Partial<ConfigFormSnapshot>, 'revision'> & { revision?: number | undefined } = {}) {
  let snapshot: ConfigFormSnapshot = {
    status: 'ready',
    writable: true,
    ...(overrides.revision === undefined && 'revision' in overrides ? {} : { revision: overrides.revision ?? 4 }),
    value: { errorCodes: ['upstream_stream_read_error', 'stream_timeout', 'stream error'], providers: [], untouched: 'keep' },
    base: { errorCodes: ['base-code'], providers: [] },
    user: {},
    ...overrides,
  } as ConfigFormSnapshot;
  const listeners = new Set<() => void>();
  const calls: { operations: readonly PathOperation[]; revision: number | undefined }[] = [];
  let behavior: ((ops: readonly PathOperation[], revision?: number) => Promise<boolean>) | undefined;
  const form: ConfigForm = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async mutate(operations, revision) {
      calls.push({ operations: plain(operations), revision });
      if (behavior) return behavior(operations, revision);
      if (revision !== snapshot.revision) return false;
      const value = { ...(snapshot.value as Record<string, unknown>) };
      for (const op of operations) {
        const key = op.path[0] as string;
        value[key] = op.op === 'set' ? plain(op.value) : (snapshot.base as Record<string, unknown>)[key];
      }
      update({ value, revision: (snapshot.revision ?? 0) + 1 });
      return true;
    },
  };
  function update(patch: Partial<ConfigFormSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  }
  return { form, calls, update, listeners, setBehavior(fn: typeof behavior) { behavior = fn; } };
}

function started(mock = mockForm()) {
  const { api } = load();
  const editor = api.createEditor(mock.form) as Editor;
  const stop = editor.start();
  return { mock, editor, stop };
}

test('browser bundle asks only platform React and preserves multiword identifiers', () => {
  const { api, requested } = load();
  assert.equal(entry!.id, 'dsh-stream-retry');
  assert.deepEqual(requested, ['react']);
  assert.deepEqual(plain(api.inject), ['slots', 'configForms']);
  assert.deepEqual(api.parseList(' stream error\r\n\ncustom_CODE\n'), ['stream error', 'custom_CODE']);
});

test('registers the exact Configure slot key through public services and releases it', () => {
  const { api } = load();
  const { form } = mockForm();
  let registration: { spec: { name: string; key: string; inject(): Record<string, unknown> }; component: (props: Record<string, unknown>) => unknown } | undefined;
  let disposed = 0;
  const effects: (() => void)[] = [];
  const ctx = {
    configForms: {
      get(id: string) { assert.equal(id, 'stream-retry'); return form; },
      whileServed(ids: readonly string[], register: (served: ReadonlySet<string>) => () => void) {
        assert.deepEqual(plain(ids), ['stream-retry']);
        return register(new Set(['stream-retry']));
      },
    },
    slots: {
      inject(name: string, register: () => () => void) {
        assert.equal(name, 'plugins.row.config');
        return register();
      },
      register(spec: typeof registration extends undefined ? never : NonNullable<typeof registration>['spec'], component: (props: Record<string, unknown>) => unknown) {
        registration = { spec, component };
        return () => { disposed += 1; };
      },
    },
    effect(make: () => (() => void) | void) { const cleanup = make(); if (cleanup) effects.push(cleanup); },
  };
  api.apply(ctx);
  const reg = registration!;
  assert.equal(reg.spec.name, 'plugins.row.config');
  assert.equal(reg.spec.key, 'dsh-stream-retry#stream-retry');
  assert.equal(reg.spec.inject().configForm, form);
  assert.match(String(reg.component({ view: 'summary' })), /DSH/);
  for (const dispose of effects) dispose();
  assert.equal(disposed, 1);
});

test('stages locally and saves both fields atomically with the baseline revision', async () => {
  const { mock, editor, stop } = started();
  editor.edit('errorCodes', 'stream error\ncustom');
  editor.edit('providers', 'route-a\nroute-b');
  assert.equal(mock.calls.length, 0);
  assert.equal(await editor.save(), true);
  assert.deepEqual(plain(mock.calls[0]), {
    revision: 4,
    operations: [
      { op: 'set', path: ['errorCodes'], value: ['stream error', 'custom'] },
      { op: 'set', path: ['providers'], value: ['route-a', 'route-b'] },
    ],
  });
  assert.equal((mock.form.getSnapshot().value as Record<string, unknown>).untouched, 'keep');
  assert.equal(editor.getSnapshot().dirty, false);
  stop();
});

test('blank lists save explicit empty arrays instead of resetting defaults', async () => {
  const { mock, editor } = started();
  editor.edit('errorCodes', '   \n');
  await editor.save();
  assert.deepEqual(plain(mock.calls[0]!.operations[0]), { op: 'set', path: ['errorCodes'], value: [] });
});

test('reset stages inherited values and saves unset operations', async () => {
  const { mock, editor } = started();
  editor.reset();
  assert.equal(editor.getSnapshot().errorCodes, 'base-code');
  assert.equal(mock.calls.length, 0);
  await editor.save();
  assert.deepEqual(plain(mock.calls[0]!.operations), [
    { op: 'unset', path: ['errorCodes'] },
    { op: 'unset', path: ['providers'] },
  ]);
});

test('editing after reset sets that field while the other stays unset', async () => {
  const { mock, editor } = started();
  editor.reset();
  editor.edit('providers', 'route-a');
  await editor.save();
  assert.deepEqual(plain(mock.calls[0]!.operations), [
    { op: 'unset', path: ['errorCodes'] },
    { op: 'set', path: ['providers'], value: ['route-a'] },
  ]);
});

test('remote updates refresh a pristine page but never overwrite a draft', async () => {
  const { mock, editor } = started();
  mock.update({ value: { errorCodes: ['remote'], providers: [] }, revision: 5 });
  assert.equal(editor.getSnapshot().errorCodes, 'remote');
  editor.edit('errorCodes', 'draft');
  mock.update({ value: { errorCodes: ['remote-2'], providers: [] }, revision: 6 });
  assert.equal(editor.getSnapshot().errorCodes, 'draft');
  assert.equal(editor.getSnapshot().conflict, true);
  assert.equal(await editor.save(), false);
  assert.equal(editor.getSnapshot().errorCodes, 'draft');
});

test('refused writes keep the draft; transport failures hide raw diagnostics', async () => {
  const refused = started();
  refused.editor.edit('errorCodes', 'draft');
  refused.mock.setBehavior(async () => false);
  assert.equal(await refused.editor.save(), false);
  assert.equal(refused.editor.getSnapshot().errorCodes, 'draft');
  assert.match(refused.editor.getSnapshot().error, /草稿已保留/);

  const failing = started();
  failing.editor.edit('errorCodes', 'draft');
  failing.mock.setBehavior(async () => { throw new Error('SECRET_TRANSPORT_DETAIL'); });
  assert.equal(await failing.editor.save(), false);
  assert(!failing.editor.getSnapshot().error.includes('SECRET_TRANSPORT_DETAIL'));
});

test('prevents duplicate saves while a write is in flight', async () => {
  const { mock, editor } = started();
  let release: (value: boolean) => void = () => {};
  mock.setBehavior(() => new Promise<boolean>((resolve) => { release = resolve; }));
  editor.edit('errorCodes', 'draft');
  const first = editor.save();
  assert.equal(await editor.save(), false);
  assert.equal(mock.calls.length, 1);
  release(true);
  await first;
});

test('read-only, unavailable and missing-revision states never write', async () => {
  const readOnly = started(mockForm({ writable: false }));
  readOnly.editor.edit('errorCodes', 'draft');
  assert.equal(await readOnly.editor.save(), false);
  assert.equal(readOnly.mock.calls.length, 0);

  const unavailable = started(mockForm({ status: 'unavailable' }));
  unavailable.editor.edit('errorCodes', 'draft');
  assert.equal(await unavailable.editor.save(), false);
  assert.equal(unavailable.mock.calls.length, 0);

  const noRevision = started(mockForm({ revision: undefined }));
  noRevision.editor.edit('errorCodes', 'draft');
  assert.equal(await noRevision.editor.save(), false);
  assert.equal(noRevision.mock.calls.length, 0);
});

test('unmount cleanup removes the subscription and ignores late settlement', async () => {
  const { mock, editor, stop } = started();
  let release: (value: boolean) => void = () => {};
  mock.setBehavior(() => new Promise<boolean>((resolve) => { release = resolve; }));
  editor.edit('errorCodes', 'draft');
  const pending = editor.save();
  stop();
  release(true);
  assert.equal(await pending, true);
  assert.equal(mock.listeners.size, 0);
  assert.equal(editor.getSnapshot().saving, true);
});

test('React page renders exactly the two accessible list editors', () => {
  const nodes: { type: string; props: Record<string, unknown> }[] = [];
  const react = {
    // A minimal renderer: element types that are functions really render here, and
    // the returned tree is flattened into the node list the assertions inspect.
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown {
      const merged = { ...(props ?? {}), children: children.length === 1 ? children[0] : children };
      if (typeof type === 'function') return (type as (p: Record<string, unknown>) => unknown)(merged);
      const node = { type: String(type), props: merged };
      nodes.push(node);
      return node;
    },
    useState<T>(initial: () => T) { return [initial(), () => {}] as [T, (value: T) => void]; },
    useEffect() {},
    useSyncExternalStore<T>(_: unknown, getSnapshot: () => T) { return getSnapshot(); },
  };
  const { api } = load(react);
  const { form } = mockForm();
  const captured: { component?: (props: Record<string, unknown>) => unknown } = {};
  const ctx = {
    configForms: {
      get: () => form,
      whileServed: (_ids: readonly string[], register: (served: ReadonlySet<string>) => () => void) => register(new Set(['stream-retry'])),
    },
    slots: {
      inject: (_name: string, register: () => () => void) => register(),
      register: (_spec: unknown, component: (props: Record<string, unknown>) => unknown) => { captured.component = component; return () => {}; },
    },
    effect: (make: () => (() => void) | void) => { make(); },
  };
  api.apply(ctx);
  captured.component!({ view: 'page', configForm: form });
  const textareas = nodes.filter((node) => node.type === 'textarea');
  assert.equal(textareas.length, 2);
  assert.deepEqual(textareas.map((node) => node.props.id), ['dsh-stream-retry-errorCodes', 'dsh-stream-retry-providers']);
  for (const node of textareas) {
    assert.equal(node.props.disabled, false);
    assert.equal(typeof node.props['aria-describedby'], 'string');
  }
  assert.equal(nodes.filter((node) => node.type === 'label').length, 2);
});