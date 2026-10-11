import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AuditLogger } from '../src/audit-logger.js';
import { ArtifactStore } from '../src/artifacts/artifact-store.js';
import { ToolRegistry } from '../src/tool-registry.js';

// REVIEW PROOF TEST (lives only in the reviewer snapshot).
//
// Invariant: the artifact tools must authorize using the TRUSTED transport
// context, never the caller-supplied `args.agentId`.
//
// Before the fix `bridge_artifact_read` used `args.agentId || ctx.agentId` and
// `bridge_artifact_get` passed `args.agentId` straight into the authorization
// call with no trusted input at all, so an unbound caller that simply named the
// artifact's owner passed `ArtifactStore._authorize`
// (src/artifacts/artifact-store.js:394) and read the bytes.
//
// `bridge_artifact_cleanup` is classified IDEMPOTENT (effectful) in
// src/effects/effects-ledger.js:76, so calling it through `executeTool` would
// first demand an attempt/epoch context and fail for an unrelated reason.
// Its handler is therefore invoked directly, which is the correct level to test
// the authorization logic (the effectful wrapper is a separate control that a
// caller with a valid attempt token already satisfies).

function setup() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-artifact-'));
  const logger = new AuditLogger(path.join(tmpDir, 'test.sqlite'));
  const store = new ArtifactStore(logger);
  const registry = new ToolRegistry();
  const latestArtifactId = () => logger.db
    .prepare('SELECT artifact_id FROM bridge_artifacts ORDER BY created_at DESC LIMIT 1')
    .get()?.artifact_id;
  return { tmpDir, logger, store, registry, latestArtifactId };
}

test('REVIEW PROOF: artifact reads must not authorize from a caller-supplied agentId', async (t) => {
  const { tmpDir, logger, store, registry, latestArtifactId } = setup();
  t.after(() => {
    try { logger.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const SECRET = 'TOP SECRET ARTIFACT BYTES';
  store.put({ agentId: 'claude-desktop', bytes: Buffer.from(SECRET), filename: 'secret.txt' });
  const artifactId = latestArtifactId();
  assert.ok(artifactId, 'test setup must have stored an artifact');

  // Unbound context: the transport provides no identity at all.
  const unboundCtx = { isPrivileged: false, artifactStore: store, logger };

  await assert.rejects(
    () => registry.executeTool('bridge_artifact_read', { artifactId, agentId: 'claude-desktop' }, unboundCtx),
    /Unauthorized|not authorized|authenticated agentId/i,
    'an unbound caller naming the owner must not read the artifact bytes'
  );

  await assert.rejects(
    () => registry.executeTool('bridge_artifact_get', { artifactId, agentId: 'claude-desktop' }, unboundCtx),
    /Unauthorized|not authorized|authenticated agentId/i,
    'an unbound caller naming the owner must not read the artifact metadata'
  );

  // Control: the genuine owner, via the trusted context, still works.
  const ok = await registry.executeTool('bridge_artifact_read', { artifactId }, {
    isPrivileged: false, agentId: 'claude-desktop', artifactStore: store, logger
  });
  assert.strictEqual(Buffer.from(ok.dataBase64, 'base64').toString(), SECRET,
    'the real owner must still be able to read its own artifact');

  // Control: the stdio MCP transport carries only `boundAgentId` (it has no
  // `agentId` field - see src/mcp-server.js toolContext), so the fix must keep
  // working there or it would break the primary agent transport.
  const okStdio = await registry.executeTool('bridge_artifact_read', { artifactId }, {
    isPrivileged: false, boundAgentId: 'claude-desktop', artifactStore: store, logger
  });
  assert.strictEqual(Buffer.from(okStdio.dataBase64, 'base64').toString(), SECRET,
    'a stdio-bound owner must still be able to read its own artifact');
});

test('REVIEW PROOF: artifact cleanup must not escalate to privileged via a caller-supplied agentId', async (t) => {
  const { tmpDir, logger, store, registry, latestArtifactId } = setup();
  t.after(() => {
    try { logger.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  store.put({ agentId: 'chatgpt-desktop', bytes: Buffer.from('chatgpt owned artifact'), filename: 'c.txt' });
  const artifactId = latestArtifactId();
  assert.ok(artifactId, 'test setup must have stored an artifact');

  // Make it expired so a privileged cleanup would really delete it.
  logger.db.prepare('UPDATE bridge_artifacts SET expires_at = ? WHERE artifact_id = ?')
    .run(new Date(Date.now() - 60000).toISOString(), artifactId);

  const handler = registry.tools.get('bridge_artifact_cleanup')?.handler;
  assert.strictEqual(typeof handler, 'function', 'bridge_artifact_cleanup must be registered');

  const unboundCtx = { isPrivileged: false, artifactStore: store, logger };

  await assert.rejects(
    () => handler({ agentId: 'system' }, unboundCtx),
    /Unauthorized|forbidden|identity/i,
    "an unbound caller must not obtain the privileged cleanup path by claiming agentId 'system'"
  );

  const row = logger.db.prepare('SELECT transfer_status FROM bridge_artifacts WHERE artifact_id = ?').get(artifactId);
  assert.notStrictEqual(row.transfer_status, 'EXPIRED',
    "another agent's expired artifact must still be present after the denied cleanup");

  // Control: a genuinely privileged context can still clean up.
  const res = await handler({}, { isPrivileged: true, artifactStore: store, logger });
  assert.ok(res.cleaned >= 1, 'privileged cleanup must still reclaim the expired artifact');
});
