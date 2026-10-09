/**
 * Integration harness: loads the installed DSH through its public package exports
 * and mounts the built plugin next to the official retry executor. No real provider
 * is contacted; the mock adapter replaces every model call.
 */
import { createRequire } from 'node:module';
import { join, resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import * as plugin from '../lib/index.js';

interface ResolvedRuntime {
  manifest: string;
}

/**
 * Resolve the installed DSH without shipping any absolute machine path.
 * Point \`DSH_RUNTIME_ROOT\` at the directory that contains \`@deepseek-ai/dsh\`
 * (its package root, or a parent whose node_modules does), or run the tests where
 * \`@deepseek-ai/dsh\` resolves normally.
 */
function resolveRuntimeManifest(): ResolvedRuntime {
  const override = process.env.DSH_RUNTIME_ROOT;
  const bases: string[] = [];
  if (override) {
    const root = resolve(override);
    bases.push(root, join(root, 'node_modules'), join(root, 'node_modules', '@deepseek-ai'), join(root, 'package.json'));
  }
  const requireFrom = (base: string) => createRequire(base.endsWith('package.json') ? base : join(base, 'package.json'));
  const lookups = [
    ...bases.map((base) => () => requireFrom(base).resolve('@deepseek-ai/dsh/package.json')),
    () => requireFrom(join(process.cwd(), 'package.json')).resolve('@deepseek-ai/dsh/package.json'),
    () => requireFrom(new URL('../package.json', import.meta.url).pathname).resolve('@deepseek-ai/dsh/package.json'),
  ];
  for (const lookup of lookups) {
    try {
      const manifest = lookup();
      // The owning declaration is the base other public packages resolve from.
      createRequire(manifest).resolve('@deepseek-ai/dsh-llm');
      return { manifest };
    } catch { /* try the next documented resolution base */ }
  }
  throw new Error('Cannot locate an installed @deepseek-ai/dsh. Set DSH_RUNTIME_ROOT to the directory that contains it (for example /usr/local/lib for a global install).');
}

const resolved = resolveRuntimeManifest();
const requireRuntime = createRequire(resolved.manifest);
requireRuntime.resolve('@deepseek-ai/dsh-llm/package.json');
export const runtimeRoot = dirname(resolved.manifest);
export const runtimeVersion = (requireRuntime('./package.json') as { version: string }).version;
export const load = async <T = Record<string, unknown>>(name: string): Promise<T> =>
  import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/' + name)).href) as Promise<T>;

/** Load a package an older DSH does not ship; undefined instead of a resolution error. */
export const loadOptional = async <T = Record<string, unknown>>(name: string): Promise<T | undefined> => {
  try { return await load<T>(name); } catch { return undefined; }
};

// Fail closed: no test path may contact a real provider.
globalThis.fetch = (async () => { throw new Error('Integration tests forbid network fetch'); }) as typeof fetch;

/** Loaded core services; kept loosely typed because only the public shapes matter. */
interface CoreModules { Context: new () => any; llm: any }
const [cordis, llmModule] = await Promise.all([load<any>('cordis'), load<any>('dsh-llm')]);
const core = await Promise.all([
  'dsh-system-prompt', 'dsh-session', 'dsh-session-projection',
  'dsh-agent', 'dsh-llm', 'dsh-tools', 'dsh-agent-loop',
].map((name) => load<any>(name)));
const officialRetry = await load<any>('dsh-llm-retry');

export const Context: CoreModules['Context'] = cordis.Context;
export const llm = llmModule;

/** Text a failed attempt publishes before dying; it must never reach a request. */
export const PARTIAL = 'FAILED_PARTIAL_MUST_NOT_ENTER_REQUEST';
export const provider = 'integration-mock';
export const model = 'integration-model';

/** Failure injected into the first attempt(s) of a mock route. */
export type InjectedFailure = { code: string; message: string; status?: number } | Error;

/** One adapter state shared by a route's assertions. */
interface AdapterState {
  events: any[];
  frames: any[];
  requests: { messages: any; signal: AbortSignal | undefined; provider: string; frozen: boolean }[];
}

interface MockAdapterOptions {
  failure?: InjectedFailure;
  failures?: number | number[];
  maxRetries?: number;
  delayMs?: number;
  tool?: string;
}

export class MockAdapter extends llm.LlmAdapter {
  state: AdapterState;
  failure: InjectedFailure | undefined;
  failures: number | number[];
  tool: string | undefined;
  toolEmitted = false;
  policy: unknown;

  constructor(state: AdapterState, { failure, failures = 1, maxRetries = 2, delayMs = 1, tool }: MockAdapterOptions = {}) {
    super();
    this.state = state;
    this.failure = failure;
    this.failures = failures;
    this.tool = tool;
    this.policy = llm.resolveRetryPolicy({
      mode: 'normal',
      maxRetries,
      backoff: { initialDelayMs: delayMs, maxDelayMs: delayMs, jitterRatio: 0 },
    }, 'integration.retryPolicy');
  }

  providerRetryPolicy(): unknown { return this.policy; }

  async *stream(options: any): AsyncGenerator<unknown> {
    this.state.requests.push({
      messages: structuredClone(options.messages),
      signal: options.signal,
      provider: options.provider,
      frozen: Object.isFrozen(options),
    });
    const attempt = this.state.requests.length;
    const injected = Array.isArray(this.failures) ? this.failures.includes(attempt) : attempt <= this.failures;
    if (injected) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: PARTIAL };
      if (this.failure instanceof Error) throw this.failure;
      yield { type: 'finish', reason: { kind: 'error', failure: this.failure } };
      return;
    }
    if (this.tool !== undefined && !this.toolEmitted) {
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

interface RuntimeOptions {
  config?: Record<string, unknown>;
  product?: boolean;
  retry?: boolean;
  subagents?: boolean;
  persistent?: boolean;
}

/** One mounted runtime; \`dispose\` tears everything down and removes temp data. */
export interface Runtime {
  ctx: any;
  registerMock(route: string, adapter?: MockAdapterOptions): AdapterState;
  createAgent(options: { sessionId: string; route?: string; adapter?: MockAdapterOptions } & Record<string, unknown>): Promise<any>;
  dispose(): Promise<void>;
}

export async function createRuntime({ config = {}, product = true, retry = true, subagents = false, persistent = false }: RuntimeOptions = {}): Promise<Runtime> {
  const ctx = new Context();
  const handles: any[] = [];
  const states = new Map<string, AdapterState>();
  const routes = new Map<string, AdapterState>();
  let temporaryRoot: string | undefined;
  async function cleanup(): Promise<void> {
    const failures: unknown[] = [];
    async function settle(operation: () => Promise<unknown>): Promise<void> {
      try { await operation(); } catch (error) { failures.push(error); }
    }
    try {
      if (subagents && ctx.get('subagents')) {
        if (typeof ctx.subagents.waitForChildren === 'function') {
          // 0.2.1-alpha.2 joins (never cancels) each parent's descendants.
          for (const handle of handles) await settle(() => ctx.subagents.waitForChildren(handle.agent));
        } else {
          await settle(() => ctx.subagents.drainContinuableDescendants(handles.map((handle) => handle.agent)));
        }
      }
      for (const handle of [...handles].reverse()) await settle(() => handle.dispose());
      await settle(() => ctx.fiber.dispose());
    } finally {
      if (temporaryRoot) {
        // Delete only the exact mkdtemp child this run created.
        if (dirname(temporaryRoot) !== resolve(tmpdir()) || !basename(temporaryRoot).startsWith('dsh-stream-retry-test-')) {
          throw new Error('Refusing unsafe integration temporary-directory cleanup');
        }
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Integration runtime teardown failed');
  }
  function registerMock(route: string, adapter: MockAdapterOptions = {}): AdapterState {
    const state: AdapterState = { events: [], frames: [], requests: [] };
    routes.set(route, state);
    ctx.llm.registerAdapter([route], new MockAdapter(state, adapter));
    return state;
  }
  try {
    for (const module of core) await ctx.plugin(module.default).await();
    if (persistent) {
      temporaryRoot = await mkdtemp(join(resolve(tmpdir()), 'dsh-stream-retry-test-'));
      const persistence = await load<any>('dsh-session-persistence-jsonl');
      await ctx.plugin(persistence.default, { root: temporaryRoot }).await();
      // Real query backend with exact reads enabled; no SQLite import/index needed.
      const query = await load<any>('dsh-session-query-sqlite');
      await ctx.plugin(query.default, { path: ':memory:', openAt: 'never' }).await();
    }
    if (subagents) {
      // 0.2.1-alpha.2 resolves every child through the Session working directory, so
      // its subagent service stays parked until `fs` and working-directory exist.
      // Runtimes without that package keep the exact earlier composition.
      const workingDirectory = await loadOptional<any>('dsh-working-directory');
      if (workingDirectory) {
        const fsLocal = await loadOptional<any>('dsh-fs-local');
        if (fsLocal) await ctx.plugin(fsLocal.default, {}).await();
        await ctx.plugin(workingDirectory.default, {}).await();
      }
      await ctx.plugin((await load<any>('dsh-subagent')).default, {}).await();
      await ctx.plugin(await load<any>('dsh-subagent-spawn-in-process'), {}).await();
      await ctx.plugin(await load<any>('dsh-subagent-fork-in-process'), {}).await();
    }
    if (retry) await ctx.plugin(officialRetry, {}).await();
    if (product) await ctx.plugin(plugin, config).await();
    ctx.on('agent/created', ({ agent }: any) => {
      const state = routes.get(agent.options.provider);
      if (state) states.set(agent.id, state);
    });
    ctx.on('session/event', (session: any, event: any) => states.get(session.id)?.events.push(event));
    ctx.on('agent/assistant-stream', ({ agent, frame }: any) => {
      const state = states.get(agent.session.id);
      if (state) state.frames.push(frame);
    });
    return {
      ctx,
      registerMock,
      async createAgent({ sessionId, route = provider, adapter = {}, ...options }: any) {
        const state = registerMock(route, adapter);
        states.set(sessionId, state);
        const handle = await ctx.agents.create({
          sessionId,
          agentOptions: { provider: route, model },
          ...options,
        });
        handles.push(handle);
        return { ...handle, state };
      },
      dispose: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** One started child, shaped alike across the released and activation subagent APIs. */
export interface ChildRun {
  /** The child's durable session id. */
  readonly childId: string;
  /** Accepted initial prompt id, when the backend has a local inbox. */
  readonly messageId?: string;
  /** Whether the run owns a real same-process Agent. */
  readonly local: boolean;
  /** The terminal result, when this API exposes one. */
  readonly result?: Promise<{ stopReason: string; output: readonly unknown[] }>;
  /** Release this exact activation; never a later resume. */
  dispose(): Promise<void>;
}

/** The provider-independent part of one child request. */
export interface ChildSpec {
  provider: string;
  label: string;
  childId: string;
  request: { parent: any; prompt: unknown; agentOptions?: unknown };
  signal: AbortSignal;
}

/**
 * Start one real in-process child through whichever public subagent API the running
 * DSH ships: `startActivation` (0.2.1-alpha.2 and later), or `start`/`startContinuable`.
 * The returned shape is identical so every caller keeps one assertion set.
 */
export async function startChild(ctx: any, spec: ChildSpec, mode: 'one-shot' | 'continuable' = 'one-shot'): Promise<ChildRun> {
  const request = {
    parent: spec.request.parent,
    prompt: spec.request.prompt,
    ...(spec.request.agentOptions === undefined ? {} : { agentOptions: spec.request.agentOptions }),
  };
  if (typeof ctx.subagents.startActivation === 'function') {
    let local = false;
    const remove = ctx.on('subagent/start', (info: any) => { if (info.id === spec.childId) local = info.local === true; });
    try {
      const activation = await ctx.subagents.startActivation({
        provider: spec.provider, label: spec.label, childId: spec.childId, request, signal: spec.signal, delivery: 'caller',
      });
      return {
        childId: activation.childId,
        messageId: activation.messageId,
        local,
        result: activation.result,
        dispose: () => activation.dispose(),
      };
    } finally { remove(); }
  }
  if (mode === 'continuable') {
    const run = await ctx.subagents.startContinuable({ ...spec, request });
    return {
      childId: run.childId,
      messageId: run.messageId,
      local: true,
      dispose: async () => { if (typeof run.dispose === 'function') await run.dispose(); },
    };
  }
  const run = await ctx.subagents.start(spec.provider, { ...request, label: spec.label, signal: spec.signal });
  return { childId: run.id, local: run.localAgent !== undefined, result: run.result, dispose: () => run.dispose() };
}

/** Send one turn and wait for quiescence. */
export async function runTurn(handle: any, text = 'Please respond.'): Promise<AdapterState> {
  handle.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  return handle.state;
}

export const events = (state: AdapterState, type: string): any[] => state.events.filter((event) => event.type === type);
export const attemptChunks = (event: any): any[] =>
  llm.expandAssistantStream(event.data.stream).map((item: any) => item.chunk);