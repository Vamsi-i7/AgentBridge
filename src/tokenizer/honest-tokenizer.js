/**
 * Honest BPE Tokenizer Approximation
 *
 * Implements regex segmentation following OpenAI's cl100k_base pattern:
 * /(?:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]|\s+(?!\S)|\s+/gu
 * 
 * Approximate subword segmentation without full BPE merge-tables.
 * Known limitation: unverified error margin of approximately ±5% on code, whitespace, and special tokens.
 * Zero external runtime dependencies.
 */

const CL100K_REGEX = /(?:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]|\s+(?!\S)|\s+/gu;

export class HonestTokenizer {
  static name = 'cl100k_base-bpe-approximator (approximate, unverified error ±5%)';

  /**
   * Count tokens in a given string using cl100k regex BPE segmentation.
   * @param {string} text
   * @returns {number}
   */
  static countTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    const matches = text.match(CL100K_REGEX);
    if (!matches) return 0;

    let tokenCount = 0;
    for (const match of matches) {
      // Subword length heuristic for very long uninterrupted alphanumeric sequences (> 6 chars)
      if (match.length > 8 && /^ ?[a-zA-Z0-9_]+$/.test(match)) {
        tokenCount += Math.ceil(match.length / 4);
      } else {
        tokenCount += 1;
      }
    }
    return tokenCount;
  }

  /**
   * Generate text with approximately the target token count.
   * @param {number} targetTokens
   * @returns {string}
   */
  static generateTextOfTokenLength(targetTokens) {
    const baseWords = [
      'The', 'distributed', 'consensus', 'protocol', 'ensures', 'that', 'all', 'peer', 'nodes',
      'maintain', 'monotonic', 'epoch', 'ordering', 'across', 'asynchronous', 'network', 'hops.',
      'Durable', 'commits', 'in', 'SQLite', 'occur', 'strictly', 'before', 'event', 'bus', 'notification.',
      'Every', 'attempt', 'lease', 'is', 'fenced', 'with', 'a', 'unique', 'cryptographic', 'nonce', 'token.'
    ];

    let result = [];
    let currentTokens = 0;
    let wordIdx = 0;

    while (currentTokens < targetTokens) {
      const word = baseWords[wordIdx % baseWords.length];
      result.push(word);
      wordIdx++;
      if (wordIdx % 10 === 0) {
        currentTokens = HonestTokenizer.countTokens(result.join(' '));
      }
    }

    return result.join(' ');
  }
}
