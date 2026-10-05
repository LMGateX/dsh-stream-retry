/**
 * Classification of one normalized model-request failure. The public seam is the
 * plugin's llm/stream hook; this module owns only the matching rules.
 * @module dsh-stream-retry/matcher
 */

/** Serialized failure facts attached to a terminal error finish chunk. */
export interface FailureFact {
  /** Stable provider-neutral machine-routing code. */
  code: string;
  /** Human-readable provider or transport failure text. */
  message: string;
  /** HTTP status returned by the provider, when available. */
  status?: number;
}

/** Codes whose message text still carries the original upstream identifier. */
const CARRIERS = new Set(['PI_AI_ERROR', 'UNKNOWN', 'STREAM_CLOSED']);

/** Failures that stay permanent even when their text carries a retryable marker. */
const PROTECTED = new Set([
  'AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'ABORTED', 'INVALID_CONFIG', 'INVALID_REQUEST',
  'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED',
  'IMAGE_OFFLOAD_REQUIRED', 'NO_ADAPTER', 'UNKNOWN_MODEL', 'INVARIANT',
  'INVALID_PREPARED_CALL', 'UNSUPPORTED_CONTENT', 'INVALID_API_KEY',
  'AUTHENTICATION_ERROR', 'PERMISSION_DENIED', 'INSUFFICIENT_QUOTA',
  'QUOTA_EXCEEDED', 'INVALID_REQUEST_ERROR', 'CONTEXT_LENGTH_EXCEEDED',
  'BILLING_HARD_LIMIT_REACHED',
]);

/** Codes the built-in retry policy already understands; keep them unchanged. */
const RETRY_CODES = new Set(['TIMEOUT', 'TRANSPORT', 'RATE_LIMIT', 'SERVER', 'EMPTY_RESPONSE']);

/** Client errors are permanent except timeout and rate-limit statuses. */
const RETRYABLE_STATUS = new Set([408, 429]);

const isProtected = (code: string): boolean => PROTECTED.has(code.toUpperCase());

/** Trim only horizontal padding; never normalize inside an identifier. */
const trimHorizontal = (text: string): string => text.replace(/^[ \t]+|[ \t]+$/g, '');

/**
 * Decide whether one terminal failure carries a configured upstream identifier.
 * Matches a structured code first, then the two known outer message formats, and
 * never searches the descriptive text after the code.
 * @param failure - normalized failure facts from the terminal finish chunk.
 * @param errorCodes - configured identifiers, matched case-sensitively.
 * @returns the matched identifier, or undefined to leave the failure unchanged.
 */
export function findErrorCode(failure: FailureFact, errorCodes: readonly string[]): string | undefined {
  if (isProtected(failure.code) || RETRY_CODES.has(failure.code)) return undefined;
  const status = failure.status;
  if (status !== undefined && status >= 400 && status < 500 && !RETRYABLE_STATUS.has(status)) return undefined;
  const allowed = new Set(errorCodes);
  if (!CARRIERS.has(failure.code) && allowed.has(failure.code)) return failure.code;
  if (!CARRIERS.has(failure.code)) return undefined;
  const message = trimHorizontal(failure.message);
  if (!isProtected(message) && !CARRIERS.has(message) && allowed.has(message)) return message;
  const outer = message.replace(/^Error Code[ \t]+/, '');
  const colon = outer.indexOf(':');
  if (colon < 0) return undefined;
  const code = trimHorizontal(outer.slice(0, colon));
  return !isProtected(code) && !CARRIERS.has(code) && allowed.has(code) ? code : undefined;
}
