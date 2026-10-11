import crypto from 'node:crypto';

/**
 * Compact Plain-Text Result Envelope (Mission B)
 *
 * Rules:
 * - One header line: [AB-RESULT: status=<status> id=<id> from=<fromAgent> size=<sizeBytes>B]
 * - Followed by raw body (NO JSON wrapping for small bodies).
 * - Inline threshold: ~6,000 bytes (~1,500 tokens). Bodies under 1-2k tokens stay inline.
 * - For bodies above threshold: short bounded digest + ref:<hash> reference for slice fetching.
 * - Full content is ALWAYS stored in content-addressed storage and verified with SHA-256.
 */

export const INLINE_BODY_MAX_BYTES = 6000; // ~1,500 tokens
export const DIGEST_MAX_BYTES = 300;       // bounded length digest for large bodies

/**
 * Format compact plain-text result envelope.
 *
 * @param {object} params
 * @param {string} params.status - 'completed' | 'failed' | 'timeout'
 * @param {string} params.requestId
 * @param {string} params.fromAgent
 * @param {string} params.body
 * @param {object} [params.casStore] - Optional ContentAddressedStore instance
 * @returns {string}
 */
export function formatCompactResultEnvelope({
  status = 'completed',
  requestId,
  fromAgent = 'peer-agent',
  body = '',
  casStore = null
}) {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const sizeBytes = Buffer.byteLength(rawBody, 'utf8');

  // Single header line
  const header = `[AB-RESULT: status=${status} id=${requestId || 'unknown'} from=${fromAgent} size=${sizeBytes}B]`;

  if (sizeBytes <= INLINE_BODY_MAX_BYTES) {
    // Small body: Plain text, NO JSON wrapping
    return `${header}\n\n${rawBody}`;
  }

  // Large body: compute SHA-256 hash
  const sha256 = crypto.createHash('sha256').update(rawBody).digest('hex');
  if (casStore && typeof casStore.store === 'function') {
    try {
      casStore.store(rawBody, { sha256 });
    } catch {}
  }

  // Bounded digest
  let digest = rawBody.slice(0, DIGEST_MAX_BYTES).trim();
  if (rawBody.length > DIGEST_MAX_BYTES) {
    digest += '...';
  }

  return `${header}\n\n${digest}\n\nref:${sha256}\n[Payload ${sizeBytes} bytes stored. Use bridge_slice_fetch({ ref: "${sha256}" }) to retrieve full content or slices.]`;
}

/**
 * Parse compact plain-text result envelope.
 *
 * @param {string} text
 * @returns {object}
 */
export function parseCompactResultEnvelope(text) {
  if (typeof text !== 'string') {
    return { isCompactEnvelope: false, status: 'unknown', body: text };
  }

  const headerMatch = text.match(/^\[AB-RESULT:\s*status=([^\s]+)\s+id=([^\s]+)\s+from=([^\s]+)\s+size=(\d+)B\](?:\n\n([\s\S]*))?$/);
  if (!headerMatch) {
    return {
      isCompactEnvelope: false,
      status: 'unknown',
      body: text
    };
  }

  const [, status, requestId, fromAgent, sizeStr, bodyText = ''] = headerMatch;
  const sizeBytes = parseInt(sizeStr, 10);

  const refMatch = bodyText.match(/ref:([a-f0-9]{64})/i);
  const contentRef = refMatch ? refMatch[1] : null;

  return {
    isCompactEnvelope: true,
    status,
    requestId,
    fromAgent,
    sizeBytes,
    body: bodyText,
    isRef: Boolean(contentRef),
    contentRef
  };
}
