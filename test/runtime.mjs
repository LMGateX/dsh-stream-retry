import { createRequire } from 'node:module';
import { join, resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import * as plugin from '../index.js';

// Resolve public package exports from an installed DSH, never workspace mocks.
// No absolute machine path ships here: set DSH_RUNTIME_ROOT to the directory that
// contains the installed @deepseek-ai/dsh (its package root, or a parent whose
// node_modules does), or run tests where @deepseek-ai/dsh resolves normally.
function resolveRuntimeManifest() {
  const override = process.env.DSH_RUNTIME_ROOT;
  const bases = [];
  if (override) {
    const root = resolve(override);
    // Accept a global install prefix, an npm package root, or the DSH package directory.
    bases.push(root, join(root, 'node_modules'), join(root, 'node_modules', '@deepseek-ai'), join(root, 'package.json'));
  }
  const requireFrom = base => createRequire(base.endsWith('package.json') ? base : join(base, 'package.json'));
  // @deepseek-ai/dsh's own declaration resolves the shared dependency copies it bundles.
  const lookups = [
    ...bases.map(base => () => requireFrom(base).resolve('@deepseek-ai/dsh/package.json')),
    () => requireFrom(join(process.cwd(), 'package.json')).resolve('@deepseek-ai/dsh/package.json'),
    () => requireFrom(new URL('../package.json', import.meta.url).pathname).resolve('@deepseek-ai/dsh/package.json'),
  ];
  for (const lookup of lookups) {
    try {
      const manifest = lookup();
      const owned = createRequire(manifest).resolve('@deepseek-ai/dsh-llm');
      return { manifest, owned };
    } catch { /* try the next documented resolution base */ }
  }
  throw new Error('Cannot locate an installed @deepseek-ai/dsh. Set DSH_RUNTIME_ROOT to the directory that contains it (for example /usr/local/lib for a global install).');
}
const resolved = resolveRuntimeManifest();
const requireRuntime = createRequire(resolved.manifest);
requireRuntime.resolve('@deepseek-ai/dsh-llm/package.json');
export const runtimeRoot = dirname(resolved.manifest);
export const runtimeVersion = requireRuntime('./package.json').version;
export const load = name => import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/' + name)).href);

// Fail closed even during public package activation; only MockAdapter is mounted.
globalThis.fetch = async () => { throw new Error('Integration tests forbid network fetch'); };
export const { Context } = await load('cordis');
export const llm = await load('dsh-llm');
const core = await Promise.all([
  'dsh-system-prompt', 'dsh-session', 'dsh-session-projection',
  'dsh-agent', 'dsh-llm', 'dsh-tools', 'dsh-agent-loop',
].map(load));
const officialRetry = await load('dsh-llm-retry');

export const PARTIAL = 'FAILED_PARTIAL_MUST_NOT_ENTER_REQUEST';
export const provider = 'integration-mock';
export const model = 'integration-model';

export class MockAdapter extends llm.LlmAdapter {
  constructor(state, { failure, failures = 1, maxRetries = 2, delayMs = 1, tool } = {}) {
    super();
    this.state = state;
    this.failure = failure;
    this.failures = failures;
    this.tool = tool;
    this.toolEmitted = false;
    this.policy = llm.resolveRetryPolicy({ mode: 'normal', maxRetries,
      backoff: { initialDelayMs: delayMs, maxDelayMs: delayMs, jitterRatio: 0 } }, 'integration.retryPolicy');
  }
  providerRetryPolicy() { return this.policy; }
  async *stream(options) {
    this.state.requests.push({ messages: structuredClone(options.messages), signal: options.signal,
      provider: options.provider, frozen: Object.isFrozen(options) });
    const attempt = this.state.requests.length;
    if (Array.isArray(this.failures) ? this.failures.includes(attempt) : attempt <= this.failures) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: PARTIAL };
      if (this.failure instanceof Error) throw this.failure;
      yield { type: 'finish', reason: { kind: 'error', failure: this.failure } };
      return;
    }
    if (this.tool && !this.toolEmitted) {
      this.toolEmitted = true;
      const block = { type: 'tool-call', id: 'integration-call-once', name: this.tool, arguments: '{}' };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: '{}' };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'RECOVERED_OK' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'RECOVERED_OK' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export async function createRuntime({ config = {}, product = true, retry = true, subagents = false, persistent = false } = {}) {
  const ctx = new Context();
  const handles = [];
  const states = new Map();
  const routes = new Map();
  let temporaryRoot;
  async function cleanup() {
    const failures = [];
    async function settle(operation) {
      try { await operation(); } catch (error) { failures.push(error); }
    }
    try {
      if (subagents && ctx.get('subagents')) {
        await settle(() => ctx.subagents.drainContinuableDescendants(handles.map(handle => handle.agent)));
      }
      for (const handle of [...handles].reverse()) await settle(() => handle.dispose());
      await settle(() => ctx.fiber.dispose());
    } finally {
      if (temporaryRoot) {
        // Delete only the exact mkdtemp child we own, never a computed broad path.
        if (dirname(temporaryRoot) !== resolve(tmpdir()) || !basename(temporaryRoot).startsWith('dsh-stream-retry-test-')) {
          throw new Error('Refusing unsafe integration temporary-directory cleanup');
        }
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Integration runtime teardown failed');
  }
  function registerMock(route, adapter = {}) {
    const state = { events: [], frames: [], requests: [] };
    routes.set(route, state);
    ctx.llm.registerAdapter([route], new MockAdapter(state, adapter));
    return state;
  }
  try {
    for (const module of core) await ctx.plugin(module.default).await();
    if (persistent) {
      temporaryRoot = await mkdtemp(join(resolve(tmpdir()), 'dsh-stream-retry-test-'));
      const persistence = await load('dsh-session-persistence-jsonl');
      await ctx.plugin(persistence.default, { root: temporaryRoot }).await();
      // Real query backend with exact reads enabled; no SQLite import/index needed.
      await ctx.plugin((await load('dsh-session-query-sqlite')).default, { path: ':memory:', openAt: 'never' }).await();
    }
    if (subagents) {
      await ctx.plugin((await load('dsh-subagent')).default, {}).await();
      await ctx.plugin(await load('dsh-subagent-spawn-in-process'), {}).await();
      await ctx.plugin(await load('dsh-subagent-fork-in-process'), {}).await();
    }
    if (retry) await ctx.plugin(officialRetry, {}).await();
    if (product) await ctx.plugin(plugin, config).await();
    ctx.on('agent/created', ({ agent }) => {
      const state = routes.get(agent.options.provider);
      if (state) states.set(agent.id, state);
    });
    ctx.on('session/event', (session, event) => states.get(session.id)?.events.push(event));
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      const state = states.get(agent.session.id);
      if (state) state.frames.push(frame);
    });
    return {
      ctx, states, registerMock,
      async createAgent({ sessionId, route = provider, adapter = {}, ...options }) {
        const state = registerMock(route, adapter);
        states.set(sessionId, state);
        const handle = await ctx.agents.create({ sessionId,
          agentOptions: { provider: route, model }, ...options });
        handles.push(handle);
        return { ...handle, state };
      },
      dispose: cleanup,
    };
  } catch (error) { await cleanup(); throw error; }
}

export async function runTurn(handle, text = 'Please respond.') {
  handle.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  return handle.state;
}
export const events = (state, type) => state.events.filter(event => event.type === type);
export const attemptChunks = event => llm.expandAssistantStream(event.data.stream).map(item => item.chunk);
