/**
 * Title Matching Utilities
 * Shared functions for handling truncated and normalized title matching
 */

/**
 * Common short words that are likely complete even at 1-3 characters
 */
const COMMON_SHORT_WORDS = new Set([
    'a', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'i', 'if', 'in',
    'is', 'it', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up', 'us', 'we',
    'ai', 'uk', 'tv', 'ok', 'vs'
]);

/**
 * Strip trailing ellipsis and incomplete words from truncated titles.
 * Apple pages truncate long titles with "…" mid-word, e.g., "Simplifying AI fo…"
 * This removes the ellipsis and the incomplete word fragment.
 * 
 * @param text - The potentially truncated title
 * @returns The cleaned title with truncation artifacts removed
 */
export function stripTruncationSuffix(text: string): string {
    // Remove trailing ellipsis characters (…, ..., etc.)
    let cleaned = text.replace(/[…]+$/g, '').replace(/\.{2,}$/g, '');

    // If text was truncated, remove the incomplete trailing word
    // A truncated word is one that doesn't end at a word boundary in the original
    // We detect this by checking if the last "word" is suspiciously short (1-3 chars)
    const words = cleaned.trim().split(/\s+/);
    if (words.length > 1) {
        const lastWord = words[words.length - 1];
        // If last word is very short (1-3 chars) and not a common short word, it's likely truncated
        if (lastWord.length <= 3 && !COMMON_SHORT_WORDS.has(lastWord.toLowerCase())) {
            words.pop();
            cleaned = words.join(' ');
        }
    }

    return cleaned.trim();
}

/**
 * Check if a title appears to be truncated (ends with ellipsis)
 */
export function isTruncatedTitle(text: string): boolean {
    return /[…]+$/.test(text) || /\.{2,}$/.test(text);
}
