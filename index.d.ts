import type { Context } from '@deepseek-ai/cordis';
import type Schema from '@deepseek-ai/schemastery';

/** User configuration; arrays replace defaults, rather than append to them. */
export interface ConfigInput {
  errorCodes?: string[];
  providers?: string[];
}

/** Framework-owned volatile configuration, read at each terminal failure. */
export interface RuntimeConfig {
  readonly errorCodes: { get(): readonly string[] };
  readonly providers: { get(): readonly string[] };
}

export declare const name: 'stream-retry';
export declare const inject: string[];
export declare const Config: Schema<ConfigInput, RuntimeConfig>;
export declare function apply(ctx: Context, config: RuntimeConfig): void;
