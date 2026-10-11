import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { AuditLogger } from '../src/audit-logger.js';
import {
  ArtifactStore,
  ArtifactTransferStatus,
  ArtifactError
} from '../src/artifacts/artifact-store.js';
import { ToolRegistry } from '../src/tool-registry.js';

function setupStore(maxBytes = 25 * 1024 * 1024) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-stream-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const logger = new AuditLogger(dbPath);
  const storeRoot = path.join(tmpDir, 'artifacts');
  const store = new ArtifactStore(logger, { root: storeRoot, maxBytes });
  return { tmpDir, dbPath, logger, storeRoot, store };
}

test('Mission F — Binary Artifact Streaming, Resumable Chunking & Status Lifecycle Suite', async (t) => {
  const env = setupStore(25 * 1024 * 1024);

  t.after(() => {
    try { env.logger.close(); } catch {}
    try { fs.rmSync(env.tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('1. Status lifecycle distinction: STORED -> TRANSFERRED -> DISPLAYABLE', async () => {
    // Generate valid PNG header + arbitrary payload
    const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const payload = Buffer.concat([pngHeader, Buffer.alloc(1024, 0xAB)]);
    const ref = env.store.put({
      bytes: payload,
      mimeType: 'image/png',
      agentId: 'initiator_agent',
      authorizedAgents: ['recipient_agent']
    });

    assert.strictEqual(ref.transfer_status, ArtifactTransferStatus.STORED);
    assert.strictEqual(ref.retrievable, true);

    // Initial displayable check (image/png is a displayable media type)
    const disp1 = env.store.isDisplayable(ref.artifact_id, { agentId: 'initiator_agent' });
    assert.strictEqual(disp1.displayable, true);
    assert.strictEqual(disp1.mediaType, 'image');

    // Mark as TRANSFERRED upon receipt
    const transferredMeta = env.store.markTransferred(ref.artifact_id, {
      agentId: 'recipient_agent',
      transferredTo: 'recipient_agent'
    });
    assert.strictEqual(transferredMeta.transfer_status, ArtifactTransferStatus.TRANSFERRED);

    // Mark as DISPLAYABLE in chat UI
    const displayableMeta = env.store.markDisplayable(ref.artifact_id, {
      agentId: 'recipient_agent',
      displayContext: 'chat_preview'
    });
    assert.strictEqual(displayableMeta.transfer_status, ArtifactTransferStatus.DISPLAYABLE);

    const disp2 = env.store.isDisplayable(ref.artifact_id, { agentId: 'recipient_agent' });
    assert.strictEqual(disp2.displayable, true);
    assert.strictEqual(disp2.transferStatus, ArtifactTransferStatus.DISPLAYABLE);
    assert.strictEqual(disp2.reason, 'explicitly_marked_displayable');
  });

  await t.test('2. Chunked upload session for large binary (> 8 MiB) with running SHA-256 verification', async () => {
    // Create a 10 MiB payload (exceeding MAX_INLINE_BYTES 8 MiB)
    const totalSize = 10 * 1024 * 1024; // 10 MiB
    const chunkSize = 2 * 1024 * 1024;  // 2 MiB chunks
    const chunkCount = totalSize / chunkSize;

    // Deterministic random buffer
    const testPattern = crypto.randomBytes(chunkSize);
    const fullHasher = crypto.createHash('sha256');

    const session = env.store.initUploadSession({
      agentId: 'producer_agent',
      filename: 'large_dataset.bin',
      mimeType: 'application/octet-stream',
      totalBytes: totalSize,
      authorizedAgents: ['consumer_agent']
    });

    assert.ok(session.uploadId.startsWith('upl_'));

    // Stream chunks one by one
    let offset = 0;
    for (let i = 0; i < chunkCount; i++) {
      fullHasher.update(testPattern);
      const isLast = i === chunkCount - 1;
      const chunkSha = crypto.createHash('sha256').update(testPattern).digest('hex');

      const chunkRes = env.store.writeChunk({
        uploadId: session.uploadId,
        agentId: 'producer_agent',
        chunkBytes: testPattern,
        offset,
        isLastChunk: isLast,
        chunkSha256: chunkSha
      });

      assert.strictEqual(chunkRes.offset, offset);
      assert.strictEqual(chunkRes.bytesWritten, chunkSize);
      offset += chunkSize;
      assert.strictEqual(chunkRes.totalBytesWritten, offset);
      assert.strictEqual(chunkRes.eof, isLast);
    }

    const expectedFullSha256 = fullHasher.digest('hex');

    // Finalize upload
    const finalized = env.store.finalizeUpload({
      uploadId: session.uploadId,
      agentId: 'producer_agent',
      expectedSha256: expectedFullSha256
    });

    assert.strictEqual(finalized.size_bytes, totalSize);
    assert.strictEqual(finalized.sha256, expectedFullSha256);
    assert.strictEqual(finalized.transfer_status, ArtifactTransferStatus.STORED);

    // Reading the 10 MiB artifact directly via inline read should reject due to inline ceiling
    assert.throws(
      () => env.store.read(finalized.artifact_id, { agentId: 'consumer_agent', maxBytes: ArtifactStore.maxInlineBytes }),
      (err) => err.code === 'ARTIFACT_TOO_LARGE_INLINE'
    );

    // But reading via readChunk works smoothly and verifies integrity
    const firstChunk = env.store.readChunk(finalized.artifact_id, {
      agentId: 'consumer_agent',
      offset: 0,
      length: chunkSize
    });
    assert.strictEqual(firstChunk.length, chunkSize);
    assert.strictEqual(firstChunk.offset, 0);
    assert.strictEqual(firstChunk.eof, false);
    assert.strictEqual(firstChunk.overallSha256, expectedFullSha256);
    assert.deepStrictEqual(firstChunk.bytes, testPattern);
  });

  await t.test('3. Resumable partial transfers: offset and length round-trip verification', async () => {
    // 5 MiB test data
    const dataSize = 5 * 1024 * 1024;
    const testData = crypto.randomBytes(dataSize);
    const expectedSha256 = crypto.createHash('sha256').update(testData).digest('hex');

    const ref = env.store.put({
      bytes: testData,
      mimeType: 'application/octet-stream',
      agentId: 'data_source',
      authorizedAgents: ['data_sink']
    });

    // Simulate an interrupted download that resumes from byte 3,000,000
    const resumeOffset = 3 * 1024 * 1024;
    const resumeLength = 1024 * 1024;

    const partial = env.store.readChunk(ref.artifact_id, {
      agentId: 'data_sink',
      offset: resumeOffset,
      length: resumeLength
    });

    assert.strictEqual(partial.offset, resumeOffset);
    assert.strictEqual(partial.length, resumeLength);
    assert.strictEqual(partial.totalBytes, dataSize);
    assert.strictEqual(partial.overallSha256, expectedSha256);

    const expectedSlice = testData.subarray(resumeOffset, resumeOffset + resumeLength);
    assert.deepStrictEqual(partial.bytes, expectedSlice);
  });

  await t.test('4. Stream-based ingestion via streamPut and streaming egress via createReadStream', async () => {
    const streamSize = 3 * 1024 * 1024; // 3 MiB
    const streamBuffer = crypto.randomBytes(streamSize);
    const expectedSha = crypto.createHash('sha256').update(streamBuffer).digest('hex');

    const inStream = Readable.from(streamBuffer);

    // Stream directly into ArtifactStore
    const storedMeta = await env.store.streamPut(inStream, {
      agentId: 'streaming_producer',
      filename: 'streamed_payload.bin',
      expectedSha256: expectedSha,
      authorizedAgents: ['streaming_consumer']
    });

    assert.strictEqual(storedMeta.size_bytes, streamSize);
    assert.strictEqual(storedMeta.sha256, expectedSha);

    // Stream out via createReadStream
    const outStream = env.store.createReadStream(storedMeta.artifact_id, {
      agentId: 'streaming_consumer'
    });

    const receivedChunks = [];
    for await (const chunk of outStream) {
      receivedChunks.push(chunk);
    }
    const combinedReceived = Buffer.concat(receivedChunks);

    assert.strictEqual(combinedReceived.length, streamSize);
    const outSha = crypto.createHash('sha256').update(combinedReceived).digest('hex');
    assert.strictEqual(outSha, expectedSha);
  });

  await t.test('5. Corruption and tampering detection during upload and transfer', async () => {
    const session = env.store.initUploadSession({
      agentId: 'tamper_test_agent',
      totalBytes: 2048
    });

    const chunk1 = Buffer.alloc(1024, 0x11);
    const badChunkSha = '0000000000000000000000000000000000000000000000000000000000000000';

    // Mismatched chunk SHA-256 rejects
    assert.throws(
      () => env.store.writeChunk({
        uploadId: session.uploadId,
        agentId: 'tamper_test_agent',
        chunkBytes: chunk1,
        chunkSha256: badChunkSha
      }),
      (err) => err.code === 'ARTIFACT_CHUNK_CORRUPT'
    );

    // Write both chunks so total size matches
    env.store.writeChunk({
      uploadId: session.uploadId,
      agentId: 'tamper_test_agent',
      chunkBytes: chunk1
    });
    env.store.writeChunk({
      uploadId: session.uploadId,
      agentId: 'tamper_test_agent',
      chunkBytes: chunk1,
      isLastChunk: true
    });

    // Finalizing with wrong overall hash rejects
    assert.throws(
      () => env.store.finalizeUpload({
        uploadId: session.uploadId,
        agentId: 'tamper_test_agent',
        expectedSha256: badChunkSha
      }),
      (err) => err.code === 'ARTIFACT_INTEGRITY_FAILURE'
    );
  });

  await t.test('6. Tool integration: bridge_artifact_read chunking over MCP tool boundary', async () => {
    const toolPayload = crypto.randomBytes(1024 * 512); // 512 KiB
    const toolSha = crypto.createHash('sha256').update(toolPayload).digest('hex');
    const ref = env.store.put({
      bytes: toolPayload,
      agentId: 'tool_agent',
      authorizedAgents: ['tool_reader']
    });

    const registry = new ToolRegistry();
    const ctx = { logger: env.logger, artifactStore: env.store, agentId: 'tool_reader' };

    // Read chunk 1
    const resChunk1 = await registry.executeTool('bridge_artifact_read', {
      artifactId: ref.artifact_id,
      offset: 0,
      length: 256 * 1024,
      expectedSha256: toolSha
    }, ctx);

    assert.strictEqual(resChunk1.offset, 0);
    assert.strictEqual(resChunk1.bytesRead, 256 * 1024);
    assert.strictEqual(resChunk1.eof, false);
    assert.strictEqual(resChunk1.integrityVerified, true);
    assert.strictEqual(resChunk1.expectedSha256Matches, true);

    // Read chunk 2 (final chunk)
    const resChunk2 = await registry.executeTool('bridge_artifact_read', {
      artifactId: ref.artifact_id,
      offset: 256 * 1024,
      length: 256 * 1024,
      expectedSha256: toolSha
    }, ctx);

    assert.strictEqual(resChunk2.offset, 256 * 1024);
    assert.strictEqual(resChunk2.bytesRead, 256 * 1024);
    assert.strictEqual(resChunk2.eof, true);
    assert.strictEqual(resChunk2.integrityVerified, true);

    const reassembled = Buffer.concat([
      Buffer.from(resChunk1.dataBase64, 'base64'),
      Buffer.from(resChunk2.dataBase64, 'base64')
    ]);
    assert.deepStrictEqual(reassembled, toolPayload);
  });

  await t.test('7. Multi-hundred-MiB (200 MiB) streaming round trip with resume and constant memory', async () => {
    const bigStore = setupStore(500 * 1024 * 1024); // 500 MiB configurable limit
    try {
      const totalBytes = 200 * 1024 * 1024; // 200 MiB
      const chunkSize = 4 * 1024 * 1024;   // 4 MiB chunk
      const totalChunks = totalBytes / chunkSize; // 50 chunks

      // Constant memory: single reusable 4 MiB chunk buffer
      const reusableChunk = Buffer.alloc(chunkSize, 0x5A);
      const overallHasher = crypto.createHash('sha256');

      const session = bigStore.store.initUploadSession({
        agentId: 'large_uploader',
        filename: 'large_model_weights.bin',
        mimeType: 'application/octet-stream',
        totalBytes,
        authorizedAgents: ['large_downloader']
      });

      // Phase 1: Upload first 20 chunks (80 MiB)
      for (let i = 0; i < 20; i++) {
        overallHasher.update(reusableChunk);
        bigStore.store.writeChunk({
          uploadId: session.uploadId,
          agentId: 'large_uploader',
          chunkBytes: reusableChunk,
          offset: i * chunkSize,
          isLastChunk: false
        });
      }

      // Simulate interruption: retrieve upload session status and resume from current offset
      const sessionInfo = bigStore.store.getUploadSession(session.uploadId);
      const resumeOffset = sessionInfo.bytesWritten;
      assert.strictEqual(resumeOffset, 20 * chunkSize);

      // Phase 2: Resume upload remaining 30 chunks
      for (let i = 20; i < totalChunks; i++) {
        overallHasher.update(reusableChunk);
        const isLast = i === totalChunks - 1;
        bigStore.store.writeChunk({
          uploadId: session.uploadId,
          agentId: 'large_uploader',
          chunkBytes: reusableChunk,
          offset: i * chunkSize,
          isLastChunk: isLast
        });
      }

      const expectedSha256 = overallHasher.digest('hex');
      const finalized = bigStore.store.finalizeUpload({
        uploadId: session.uploadId,
        agentId: 'large_uploader',
        expectedSha256
      });

      assert.strictEqual(finalized.size_bytes, totalBytes);
      assert.strictEqual(finalized.sha256, expectedSha256);

      // Phase 3: Constant-memory streaming read chunk by chunk
      const readHasher = crypto.createHash('sha256');
      let bytesReadTotal = 0;
      let eof = false;

      while (!eof) {
        const chunkRes = bigStore.store.readChunk(finalized.artifact_id, {
          agentId: 'large_downloader',
          offset: bytesReadTotal,
          length: chunkSize
        });
        assert.strictEqual(chunkRes.integrityVerified, true);
        readHasher.update(chunkRes.bytes);
        bytesReadTotal += chunkRes.length;
        eof = chunkRes.eof;
      }

      assert.strictEqual(bytesReadTotal, totalBytes);
      assert.strictEqual(readHasher.digest('hex'), expectedSha256);
    } finally {
      try { bigStore.logger.close(); } catch {}
      try { fs.rmSync(bigStore.tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  await t.test('8. Receiver environment path verification (verifyReceiverAccess)', async () => {
    const payload = Buffer.from('hello receiver environment');
    const ref = env.store.put({
      bytes: payload,
      agentId: 'sender_agent',
      authorizedAgents: ['local_agent', 'remote_agent']
    });

    // 8a. Path inside receiver root is accessible
    const localAccess = env.store.verifyReceiverAccess(ref.artifact_id, {
      receivingAgentId: 'local_agent',
      receiverFilesystemRoot: env.tmpDir
    });
    assert.strictEqual(localAccess.accessible, true);
    assert.strictEqual(localAccess.status, ArtifactTransferStatus.TRANSFERRED);

    // 8b. Path outside receiver root reports incomplete transfer requiring bytes
    const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-agent-root-'));
    try {
      const foreignAccess = env.store.verifyReceiverAccess(ref.artifact_id, {
        receivingAgentId: 'remote_agent',
        receiverFilesystemRoot: foreignRoot
      });
      assert.strictEqual(foreignAccess.accessible, false);
      assert.strictEqual(foreignAccess.status, 'TRANSFER_INCOMPLETE');
      assert.strictEqual(foreignAccess.requiresBytesTransfer, true);
    } finally {
      try { fs.rmSync(foreignRoot, { recursive: true, force: true }); } catch {}
    }
  });
});
