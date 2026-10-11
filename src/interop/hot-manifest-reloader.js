import fs from 'node:fs';
import path from 'node:path';

/**
 * HotManifestReloader enables zero-downtime hot-reloading of agent manifests.
 * It validates manifest structure before atomic swap; on validation failure,
 * it rolls back immediately to previous valid state without disrupting existing traffic.
 */
export class HotManifestReloader {
  constructor(options = {}) {
    this.manifestRegistry = options.manifestRegistry || new Map();
    this.eventBus = options.eventBus || null;
    this.history = [];
  }

  /**
   * Validate a single agent manifest structure.
   */
  validateManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') {
      return { valid: false, error: 'Manifest must be an object' };
    }
    if (!manifest.id || typeof manifest.id !== 'string') {
      return { valid: false, error: 'Manifest missing valid string id' };
    }
    if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
      return { valid: false, error: 'Manifest version must follow semver (e.g. 1.0.0)' };
    }
    return { valid: true };
  }

  /**
   * Atomically reload or add an agent manifest with rollback on error.
   */
  reloadManifest(manifest) {
    const check = this.validateManifest(manifest);
    if (!check.valid) {
      throw new Error(`Atomic reload rejected: ${check.error}. Current state retained.`);
    }

    const previous = this.manifestRegistry.get(manifest.id) || null;

    try {
      // Snapshot current state for rollback
      this.history.push({
        id: manifest.id,
        previousState: previous ? JSON.parse(JSON.stringify(previous)) : null,
        timestamp: Date.now()
      });

      // Apply new manifest atomically
      this.manifestRegistry.set(manifest.id, Object.freeze({ ...manifest }));

      // Notify transports of tools/list_changed and presence change without restart
      if (this.eventBus) {
        this.eventBus.emit('tools/list_changed', { agentId: manifest.id });
        this.eventBus.emit('presence:updated', { agentId: manifest.id, status: manifest.status || 'online' });
      }

      return {
        success: true,
        agentId: manifest.id,
        isUpdate: previous !== null,
        version: manifest.version || '1.0.0'
      };
    } catch (err) {
      // Rollback on any failure
      if (previous) {
        this.manifestRegistry.set(manifest.id, previous);
      } else {
        this.manifestRegistry.delete(manifest.id);
      }
      throw new Error(`Hot-reload failed and was rolled back: ${err.message}`);
    }
  }

  /**
   * Rollback the most recent manifest change.
   */
  rollbackLast() {
    const last = this.history.pop();
    if (!last) return false;

    if (last.previousState) {
      this.manifestRegistry.set(last.id, last.previousState);
    } else {
      this.manifestRegistry.delete(last.id);
    }

    if (this.eventBus) {
      this.eventBus.emit('tools/list_changed', { agentId: last.id });
    }
    return true;
  }
}
