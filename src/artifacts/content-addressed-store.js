import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

/**
 * Content-Addressed Storage (CAS) & Pass-by-Reference Store (Mission B)
 *
 * Properties:
 * 1. Content-addressed by SHA-256: identical content is never stored or transmitted twice.
 * 2. Slice-fetch: models can pull bounded windows (e.g. 1-2k tokens) on demand without loading full multi-MB payloads.
 * 3. Delta generation: follow-up turns can exchange compact line diffs rather than re-transmitting entire documents.
 * 4. Hash-verified integrity: every read verifies SHA-256 so content is never corrupted or silently truncated.
 */
export class ContentAddressedStore {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.join(os.tmpdir(), 'agent-bridge-cas');
    this.memoryCache = new Map(); // hash -> { content, size, createdAt }
    this.maxMemoryItems = options.maxMemoryItems || 200;

    try {
      if (!fs.existsSync(this.rootDir)) {
        fs.mkdirSync(this.rootDir, { recursive: true });
      }
    } catch {}
  }

  /**
   * Store content by SHA-256 hash. Deduplicates automatically.
   *
   * @param {string|Buffer} content
   * @param {object} [options]
   * @returns {{ hash: string, sizeBytes: number, deduplicated: boolean }}
   */
  store(content, options = {}) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const sizeBytes = buf.length;

    // Check memory cache
    if (this.memoryCache.has(hash)) {
      return { hash, sizeBytes, deduplicated: true };
    }

    // Check disk storage
    const filePath = path.join(this.rootDir, `${hash}.bin`);
    if (fs.existsSync(filePath)) {
      this._addToMemoryCache(hash, buf);
      return { hash, sizeBytes, deduplicated: true };
    }

    // Persist to disk
    try {
      fs.writeFileSync(filePath, buf);
    } catch {}

    this._addToMemoryCache(hash, buf);
    return { hash, sizeBytes, deduplicated: false };
  }

  /**
   * Retrieve full content by SHA-256 hash with integrity verification.
   *
   * @param {string} hash
   * @returns {{ content: string, buffer: Buffer, sizeBytes: number, hash: string, verified: boolean } | null}
   */
  get(hash) {
    if (!hash || typeof hash !== 'string') return null;
    const cleanHash = hash.replace(/^ref:/i, '').trim().toLowerCase();

    // 1. Check memory cache
    if (this.memoryCache.has(cleanHash)) {
      const entry = this.memoryCache.get(cleanHash);
      return {
        content: entry.buffer.toString('utf8'),
        buffer: entry.buffer,
        sizeBytes: entry.size,
        hash: cleanHash,
        verified: true
      };
    }

    // 2. Check disk
    const filePath = path.join(this.rootDir, `${cleanHash}.bin`);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const buf = fs.readFileSync(filePath);
      const computed = crypto.createHash('sha256').update(buf).digest('hex');
      if (computed !== cleanHash) {
        throw new Error(`CAS Integrity Mismatch: expected ${cleanHash}, got ${computed}`);
      }

      this._addToMemoryCache(cleanHash, buf);
      return {
        content: buf.toString('utf8'),
        buffer: buf,
        sizeBytes: buf.length,
        hash: cleanHash,
        verified: true
      };
    } catch {
      return null;
    }
  }

  /**
   * Slice-fetch: retrieve a bounded byte range from a stored payload.
   *
   * @param {string} hash
   * @param {number} [offset=0]
   * @param {number} [length=4000]
   * @returns {{ slice: string, offset: number, bytesRead: number, totalBytes: number, eof: boolean, hash: string } | null}
   */
  getSlice(hash, offset = 0, length = 4000) {
    const item = this.get(hash);
    if (!item) return null;

    const safeOffset = Math.max(0, Math.min(offset, item.sizeBytes));
    const safeLength = Math.max(0, Math.min(length, item.sizeBytes - safeOffset));
    const sliceBuf = item.buffer.subarray(safeOffset, safeOffset + safeLength);
    const eof = (safeOffset + safeLength) >= item.sizeBytes;

    return {
      slice: sliceBuf.toString('utf8'),
      offset: safeOffset,
      bytesRead: sliceBuf.length,
      totalBytes: item.sizeBytes,
      eof,
      hash: item.hash
    };
  }

  /**
   * Compute unified line delta between a base content reference and new content.
   *
   * @param {string} baseHash
   * @param {string} newText
   * @returns {{ baseHash: string, newHash: string, deltaText: string, savingsBytes: number } | null}
   */
  computeDelta(baseHash, newText) {
    const baseItem = this.get(baseHash);
    if (!baseItem) return null;

    const baseText = baseItem.content;
    const baseLines = baseText.split('\n');
    const newLines = String(newText).split('\n');

    // Fast simple line diff
    const diffLines = [];
    let i = 0, j = 0;
    while (i < baseLines.length || j < newLines.length) {
      if (i < baseLines.length && j < newLines.length && baseLines[i] === newLines[j]) {
        i++;
        j++;
      } else if (j < newLines.length && (i >= baseLines.length || !baseLines.includes(newLines[j]))) {
        diffLines.push(`+ ${newLines[j]}`);
        j++;
      } else if (i < baseLines.length && (j >= newLines.length || !newLines.includes(baseLines[i]))) {
        diffLines.push(`- ${baseLines[i]}`);
        i++;
      } else {
        diffLines.push(`- ${baseLines[i]}`);
        diffLines.push(`+ ${newLines[j]}`);
        i++;
        j++;
      }
    }

    const deltaText = diffLines.join('\n');
    const storeResult = this.store(newText);
    const savingsBytes = Buffer.byteLength(newText, 'utf8') - Buffer.byteLength(deltaText, 'utf8');

    return {
      baseHash: baseItem.hash,
      newHash: storeResult.hash,
      deltaText,
      savingsBytes: Math.max(0, savingsBytes)
    };
  }

  _addToMemoryCache(hash, buffer) {
    if (this.memoryCache.size >= this.maxMemoryItems) {
      const firstKey = this.memoryCache.keys().next().value;
      if (firstKey) this.memoryCache.delete(firstKey);
    }
    this.memoryCache.set(hash, { buffer, size: buffer.length, createdAt: Date.now() });
  }
}

// Global singleton for process-wide CAS deduplication
export const defaultCASStore = new ContentAddressedStore();
