/**
 * Configurable stream interruption classification for the built-in DSH request
 * retry. This plugin owns classification only: the official
 * `@deepseek-ai/dsh-llm-retry` plugin still owns budgets, backoff, cancellation,
 * and durable retry events.
 * @module dsh-stream-retry
 */
import Schema from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { Volatile } from './types.js';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "stream-retry";
/** The classification seam requires the LLM service. */
export declare const inject: string[];
/** User-editable configuration; each array replaces the schema default entirely. */
export interface Config {
    /** Upstream identifiers to reclassify as TRANSPORT. */
    errorCodes: Volatile<readonly string[]> | readonly string[];
    /** Provider routes to act on; empty means every route in this process. */
    providers: Volatile<readonly string[]> | readonly string[];
}
/**
 * Live plugin configuration. Arrays are volatile so a saved settings change applies
 * to the next terminal failure without remounting this plugin.
 */
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    errorCodes: Schema<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    providers: Schema<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    errorCodes: Schema<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    providers: Schema<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
}>>, "plain">;
/** Correct only terminal failure classification; the official retry plugin recovers. */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map