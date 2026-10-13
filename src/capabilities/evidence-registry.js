import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG } from '../config.js';
import { RouteEvidence, RouteType, AGENT_MANIFESTS } from './agent-manifest.js';

export const EVIDENCE_DIR = path.join(CONFIG.BRIDGE_ROOT, 'data', 'evidence');
export const EvidenceLevel = RouteEvidence;
export { RouteEvidence };

export class UnverifiedClaimError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnverifiedClaimError';
    this.code = 'UNVERIFIED_EVIDENCE_CLAIM';
  }
}

/**
 * Authoritative Single Source of Truth for Route Evidence (Mission 4: Evidence & Labels)
 *
 * Rules:
 * 1. `live-verified` can ONLY be set by the live harness writing a signed-off evidence record.
 * 2. Everything else tops out at `mock-tested` (or `probed` / `declared`).
 * 3. Any claim of `live-verified` without a signed record is rejected and downgraded.
 */
export class RouteEvidenceRegistry {
  constructor(options = {}) {
    this.evidenceDir = options.evidenceDir || EVIDENCE_DIR;
    this.secret = options.secret || CONFIG.CONTROL_PLANE?.API_KEY || 'agent-bridge-evidence-integrity-key';
    this._ensureDir();
  }

  _ensureDir() {
    try {
      if (!fs.existsSync(this.evidenceDir)) {
        fs.mkdirSync(this.evidenceDir, { recursive: true });
      }
    } catch  {
      // swallow-ok: intentional non-fatal error suppression
    }
  }

  _recordPath(agentId, routeId) {
    const cleanAgent = String(agentId || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const cleanRoute = String(routeId || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    return path.join(this.evidenceDir, `${cleanAgent}__${cleanRoute}.json`);
  }

  _computeSignature(record) {
    const canonical = [
      record.agentId,
      record.routeId,
      record.evidenceTier,
      record.timestamp,
      record.userConfirmationId,
      record.resultHash,
      record.appVersion,
      record.osVersion
    ].join('|');
    return crypto.createHmac('sha256', this.secret).update(canonical).digest('hex');
  }

  /**
   * Validate a recorded live-run evidence file.
   */
  validateEvidenceRecord(record) {
    if (!record || typeof record !== 'object') return { valid: false, reason: 'Record missing or invalid type' };
    if (record.evidenceTier !== RouteEvidence.LIVE_VERIFIED) {
      return { valid: false, reason: `Invalid tier '${record.evidenceTier}', must be 'live-verified'` };
    }
    if (!record.agentId || !record.routeId) return { valid: false, reason: 'Missing agentId or routeId' };
    if (!record.userConfirmationId || !String(record.userConfirmationId).startsWith('usr_conf_')) {
      return { valid: false, reason: 'Missing or invalid userConfirmationId' };
    }
    if (!record.resultHash || !/^[a-f0-9]{64}$/i.test(record.resultHash)) {
      return { valid: false, reason: 'Missing or malformed resultHash (must be SHA-256)' };
    }
    if (!record.appVersion || !record.osVersion) {
      return { valid: false, reason: 'Missing appVersion or osVersion in live evidence' };
    }
    if (!record.timestamp || isNaN(Date.parse(record.timestamp))) {
      return { valid: false, reason: 'Missing or invalid ISO timestamp' };
    }

    const expectedSig = this._computeSignature(record);
    if (!record.signature || record.signature !== expectedSig) {
      return { valid: false, reason: 'Cryptographic signature mismatch or tampered record' };
    }

    return { valid: true };
  }

  /**
   * Resolve current empirical evidence tier for a given agent and route.
   */
  getRouteEvidence(agentId, routeId) {
    const filePath = this._recordPath(agentId, routeId);
    if (fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const check = this.validateEvidenceRecord(raw);
        if (check.valid) {
          return {
            tier: RouteEvidence.LIVE_VERIFIED,
            record: raw,
            isLiveVerified: true
          };
        }
      } catch  {
      // swallow-ok: safe fallback for plaintext or non-JSON input
    }
    }

    // Default: tops out at mock-tested or declared in baseline manifest
    const manifest = AGENT_MANIFESTS[String(agentId).trim().toLowerCase()];
    const route = manifest?.routes?.find(r => r.id === routeId);
    const baselineTier = route?.evidence || RouteEvidence.DECLARED;

    return {
      tier: baselineTier === RouteEvidence.LIVE_VERIFIED ? RouteEvidence.MOCK_TESTED : baselineTier,
      record: null,
      isLiveVerified: false
    };
  }

  /**
   * Write a signed live-run evidence record (only callable with explicit user confirmation).
   */
  recordLiveVerification(data) {
    const record = {
      agentId: String(data.agentId).trim().toLowerCase(),
      routeId: String(data.routeId).trim(),
      evidenceTier: RouteEvidence.LIVE_VERIFIED,
      timestamp: data.timestamp || new Date().toISOString(),
      userConfirmationId: data.userConfirmationId,
      resultHash: data.resultHash,
      appVersion: data.appVersion || 'unknown',
      osVersion: data.osVersion || `${process.platform} ${process.arch}`,
      completionEvidence: data.completionEvidence || null,
      measuredLatencyMs: data.measuredLatencyMs || 0,
      focusPreserved: Boolean(data.focusPreserved)
    };

    record.signature = this._computeSignature(record);
    const check = this.validateEvidenceRecord(record);
    if (!check.valid) {
      throw new Error(`Failed to create valid live evidence record: ${check.reason}`);
    }

    const filePath = this._recordPath(record.agentId, record.routeId);
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
    return record;
  }

  /**
   * Enforce honesty: rejects 'live-verified' claim if no valid evidence file exists.
   */
  assertHonestTier(claimedTier, agentId, routeId) {
    if (claimedTier === RouteEvidence.LIVE_VERIFIED) {
      const resolved = this.getRouteEvidence(agentId, routeId);
      if (!resolved.isLiveVerified) {
        throw new UnverifiedClaimError(
          `Dishonest evidence claim rejected: route '${routeId}' for agent '${agentId}' claimed 'live-verified' but no signed live-run evidence record exists.`
        );
      }
    }
  }

  /**
   * Return agent manifest with evidence resolved against real records.
   */
  resolveManifest(agentId) {
    const norm = String(agentId || '').trim().toLowerCase();
    const manifest = AGENT_MANIFESTS[norm];
    if (!manifest) return null;

    const resolvedRoutes = manifest.routes.map(r => {
      const ev = this.getRouteEvidence(norm, r.id);
      return {
        ...r,
        evidence: ev.tier,
        liveEvidenceRecord: ev.record || null
      };
    });

    return {
      ...manifest,
      routes: resolvedRoutes
    };
  }

  /**
   * Return complete agent x route x evidence-level table.
   */
  generateEvidenceTable() {
    const rows = [];
    for (const [agentId, manifest] of Object.entries(AGENT_MANIFESTS)) {
      for (const route of manifest.routes) {
        const ev = this.getRouteEvidence(agentId, route.id);
        rows.push({
          agentId,
          displayName: manifest.displayName,
          appType: manifest.appType,
          routeId: route.id,
          routeType: route.type,
          evidence: ev.tier,
          isLiveVerified: ev.isLiveVerified,
          backgroundCapable: route.backgroundCapable
        });
      }
    }
    return rows;
  }
}

export const defaultEvidenceRegistry = new RouteEvidenceRegistry();
