// Private classification adapter. The public seam is the plugin's llm/stream hook.
const CARRIERS = new Set(['PI_AI_ERROR', 'UNKNOWN', 'STREAM_CLOSED']);
const PROTECTED = new Set([
  'AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'ABORTED', 'INVALID_CONFIG', 'INVALID_REQUEST',
  'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED',
  'IMAGE_OFFLOAD_REQUIRED', 'NO_ADAPTER', 'UNKNOWN_MODEL', 'INVARIANT',
  'INVALID_PREPARED_CALL', 'UNSUPPORTED_CONTENT', 'INVALID_API_KEY',
  'AUTHENTICATION_ERROR', 'PERMISSION_DENIED', 'INSUFFICIENT_QUOTA',
  'QUOTA_EXCEEDED', 'INVALID_REQUEST_ERROR', 'CONTEXT_LENGTH_EXCEEDED',
  'BILLING_HARD_LIMIT_REACHED',
]);
const RETRY_CODES = new Set(['TIMEOUT', 'TRANSPORT', 'RATE_LIMIT', 'SERVER', 'EMPTY_RESPONSE']);
const protectedCode = code => PROTECTED.has(code.toUpperCase());
const trimHorizontal = text => text.replace(/^[ \t]+|[ \t]+$/g, '');

export function findErrorCode(failure, errorCodes) {
  if (protectedCode(failure.code) || RETRY_CODES.has(failure.code)) return undefined;
  if (failure.status >= 400 && failure.status < 500 && failure.status !== 408 && failure.status !== 429) return undefined;
  const allowed = new Set(errorCodes);
  if (!CARRIERS.has(failure.code) && allowed.has(failure.code)) return failure.code;
  if (!CARRIERS.has(failure.code)) return undefined;
  const message = trimHorizontal(failure.message);
  if (!protectedCode(message) && !CARRIERS.has(message) && allowed.has(message)) return message;
  const outer = message.replace(/^Error Code[ \t]+/, '');
  const colon = outer.indexOf(':');
  if (colon < 0) return undefined;
  const code = trimHorizontal(outer.slice(0, colon));
  return !protectedCode(code) && !CARRIERS.has(code) && allowed.has(code) ? code : undefined;
}
