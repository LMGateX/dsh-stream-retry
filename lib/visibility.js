/**
 * Visible-content tracking for one assistant stream.
 *
 * A completed response can carry reasoning and an empty text block and nothing
 * else. The adapter still reports that as a normal `stop`, so the loop cannot
 * tell it apart from a real answer and ends the turn silently. This module
 * decides, from the live chunk stream, whether a response produced anything a
 * user or the loop can act on.
 * @module dsh-stream-retry/visibility
 */
/** Block types that never count as visible on their own. */
const INVISIBLE_BLOCKS = new Set(['text', 'thinking', 'reasoning']);
/**
 * Whether a value carries non-whitespace text.
 * @param value - candidate text.
 * @returns whether it contains at least one non-whitespace character.
 */
export function hasNonWhitespace(value) {
    return typeof value === 'string' && /[^\s]/u.test(value);
}
/** Read one assembled block without trusting its shape. */
function blockOf(chunk) {
    const block = chunk.block;
    return block !== null && typeof block === 'object' ? block : undefined;
}
/**
 * Whether one live chunk proves the response carries visible content.
 * Tool calls, images and files count: rewriting such a completion would throw
 * away work the loop still has to execute or show.
 * @param chunk - one chunk of an adapter stream.
 * @returns whether the chunk makes the response non-empty for retry purposes.
 */
export function chunkIsVisible(chunk) {
    switch (chunk.type) {
        case 'text-delta':
            return hasNonWhitespace(chunk.text);
        case 'tool-call-delta':
            return true;
        case 'block-start':
            return !INVISIBLE_BLOCKS.has(String(chunk.blockType));
        case 'block-end': {
            const block = blockOf(chunk);
            if (block === undefined)
                return false;
            if (block.type === 'text')
                return hasNonWhitespace(block.text);
            return !INVISIBLE_BLOCKS.has(String(block.type));
        }
        default:
            return false;
    }
}
//# sourceMappingURL=visibility.js.map