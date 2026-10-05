/**
 * Type-only declarations for the two DSH packages this plugin compiles against.
 * They are supplied by the installed Harness at runtime (peer dependencies) and are
 * declared here so the TypeScript build does not ship a second copy of the runtime.
 * @module dsh-stream-retry/harness-types
 */
declare module '@deepseek-ai/cordis' {
  /** Minimal context surface; the plugin narrows it at each use. */
  export interface Context {
    on(event: string, listener: (...args: any[]) => any): () => void;
    effect(job: () => (() => void) | void, label?: string): void;
    logger: { info(message: string, ...args: unknown[]): void };
  }
}

declare module '@deepseek-ai/dsh-llm' {
  /** Replay metadata attached to a successful assistant message. */
  export interface ReplayEnvelope { readonly [key: string]: unknown }
  /** Terminal reason of one assistant stream. */
  export type FinishReason =
    | { kind: 'stop' | 'max-tokens' | 'tool-calls' }
    | { kind: 'error'; failure: { code: string; message: string; status?: number; providerRetryAfterMs?: number; requestId?: string; offloadImages?: number } }
    | { kind: 'aborted'; failure: { code: string; message: string } };
  /** One chunk of an adapter stream. */
  export type StreamChunk =
    | { type: 'block-start'; index: number; blockType: string }
    | { type: 'text-delta'; index: number; text: string }
    | { type: 'reasoning-delta'; index: number; text: string }
    | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
    | { type: 'block-end'; index: number; block: unknown }
    | { type: 'usage'; usage: unknown }
    | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope };
  /** Call shape the loop hands to a prepared stream. */
  export interface GenerateOptions {
    readonly provider: string;
    readonly model: string;
    readonly signal?: AbortSignal;
  }
}

// Side-effect augmentation: the installed llm package declares ctx.llm and llm/stream.
declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: unknown;
  }
  interface Events {
    'llm/stream'(this: unknown, options: any, next: () => AsyncIterable<any>): AsyncIterable<any>;
  }
}
