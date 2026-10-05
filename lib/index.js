/**
 * Configurable stream interruption classification for the built-in DSH request
 * retry. This plugin owns classification only: the official
 * `@deepseek-ai/dsh-llm-retry` plugin still owns budgets, backoff, cancellation,
 * and durable retry events.
 * @module dsh-stream-retry
 */
import Schema from '@deepseek-ai/schemastery';
import { findErrorCode } from './matcher.js';
/** Cordis plugin name used by loader diagnostics. */
export const name = 'stream-retry';
/** The classification seam requires the LLM service. */
export const inject = ['llm'];
const identifier = Schema.string()
    .min(1)
    .max(200)
    .pattern(/^[^:\s"'\u0060\u0000-\u001f\u007f](?:[^:"'\u0060\u0000-\u001f\u007f]*[^:\s"'\u0060\u0000-\u001f\u007f])?$/u);
const provider = Schema.string().min(1).max(200).pattern(/^\S+$/u);
/** Read a live configuration reference without caching its snapshot. */
const readLive = (field) => field.get();
/**
 * Live plugin configuration. Arrays are volatile so a saved settings change applies
 * to the next terminal failure without remounting this plugin.
 */
export const Config = Schema.object({
    errorCodes: Schema.array(identifier)
        .max(100)
        .description('可重试的上游错误标识。区分大小写、完整字面匹配；不要填写冒号后的描述。可增删预设；空列表关闭兼容映射。')
        .default(['upstream_stream_read_error', 'stream_timeout', 'stream error'])
        .volatile(),
    providers: Schema.array(provider)
        .max(100)
        .description('生效的 provider 路由，精确匹配。空列表表示所有同进程 provider；不支持通配符。')
        .default([])
        .volatile(),
});
/** Correct only terminal failure classification; the official retry plugin recovers. */
export function apply(ctx, config) {
    let active = true;
    ctx.effect(() => () => { active = false; }, 'stream-retry: stop captured classifiers');
    ctx.on('llm/stream', async function* (options, next) {
        for await (const chunk of next()) {
            if (!active || chunk.type !== 'finish' || chunk.reason.kind !== 'error' || options.signal?.aborted) {
                yield chunk;
                continue;
            }
            const providers = readLive(config.providers);
            if (providers.length > 0 && !providers.includes(options.provider)) {
                yield chunk;
                continue;
            }
            const failure = chunk.reason.failure;
            const matched = findErrorCode(failure, readLive(config.errorCodes));
            if (matched === undefined) {
                yield chunk;
                continue;
            }
            ctx.logger.info('stream-retry: provider=%s originalCode=%s matchedCode=%s classified=TRANSPORT', options.provider, failure.code, matched);
            yield { ...chunk, reason: { ...chunk.reason, failure: { ...failure, code: 'TRANSPORT' } } };
        }
    });
}
//# sourceMappingURL=index.js.map