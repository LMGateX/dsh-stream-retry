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
/**
 * Decide whether one terminal failure carries a configured upstream identifier.
 * Matches a structured code first, then the two known outer message formats, and
 * never searches the descriptive text after the code.
 * @param failure - normalized failure facts from the terminal finish chunk.
 * @param errorCodes - configured identifiers, matched case-sensitively.
 * @returns the matched identifier, or undefined to leave the failure unchanged.
 */
export declare function findErrorCode(failure: FailureFact, errorCodes: readonly string[]): string | undefined;
//# sourceMappingURL=matcher.d.ts.map