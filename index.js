import Schema from '@deepseek-ai/schemastery';
import { findErrorCode } from './matcher.js';
export const name = 'stream-retry';
export const inject = ['llm'];
const identifier = Schema.string().min(1).max(200).pattern(/^[^:\s"'\u0060\u0000-\u001f\u007f](?:[^:"'\u0060\u0000-\u001f\u007f]*[^:\s"'\u0060\u0000-\u001f\u007f])?$/u);
const provider = Schema.string().min(1).max(200).pattern(/^\S+$/u);

/** Arrays are live settings; never cache their snapshots across requests. */
export const Config = Schema.object({
  errorCodes: Schema.array(identifier).max(100)
    .description('可重试的上游错误标识。区分大小写、完整字面匹配；不要填写冒号后的描述。可增删预设；空列表关闭兼容映射。')
    .default(['upstream_stream_read_error', 'stream_timeout', 'stream error']).volatile(),
  providers: Schema.array(provider).max(100)
    .description('生效的 provider 路由，精确匹配。空列表表示所有同进程 provider；不支持通配符。')
    .default([]).volatile(),
});
/** Correct only terminal failure classification; official llm-retry owns recovery. */
export function apply(ctx, config) {
  let active = true;
  ctx.effect(() => () => { active = false; }, 'stream-retry: stop captured classifiers');
  ctx.on('llm/stream', async function* (options, next) {
    for await (const chunk of next()) {
      if (!active || chunk.type !== 'finish' || chunk.reason.kind !== 'error' || options.signal?.aborted) {
        yield chunk;
        continue;
      }
      const providers = config.providers.get();
      if (providers.length > 0 && !providers.includes(options.provider)) {
        yield chunk;
        continue;
      }
      const matched = findErrorCode(chunk.reason.failure, config.errorCodes.get());
      if (matched === undefined) { yield chunk; continue; }
      ctx.logger.info('stream-retry: provider=%s originalCode=%s matchedCode=%s classified=TRANSPORT', options.provider, chunk.reason.failure.code, matched);
      yield { ...chunk, reason: { ...chunk.reason, failure: { ...chunk.reason.failure, code: 'TRANSPORT' } } };
    }
  });
}
