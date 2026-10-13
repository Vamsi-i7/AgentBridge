#!/usr/bin/env node

/**
 * scripts/normalize-agent-ids.js
 *
 * Normalization utility for legacy database rows stored with agent aliases (e.g., to_agent='chatgpt').
 * Dry-run by default. Refuses to touch the live database without --i-understand-live.
 *
 * Usage:
 *   node scripts/normalize-agent-ids.js <path-to-db> [--apply] [--i-understand-live]
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { AGENT_ALIASES, normalizeAgentId } from '../src/agent-identity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const applyMode = args.includes('--apply');
const understandLive = args.includes('--i-understand-live');
const pathArg = args.find(a => !a.startsWith('--'));

if (!pathArg) {
  console.log('Usage: node scripts/normalize-agent-ids.js <path-to-db> [--apply] [--i-understand-live]');
  console.log('  By default runs in DRY-RUN mode.');
  console.log('  --apply: actually execute updates in a transaction');
  console.log('  --i-understand-live: required if targeting live database');
  process.exit(1);
}

const targetPath = path.resolve(pathArg);
if (!fs.existsSync(targetPath)) {
  console.error(`Error: Database file does not exist at '${targetPath}'`);
  process.exit(1);
}

const livePath = path.resolve(CONFIG.DB_PATH);
const isTargetLive = (targetPath === livePath);

if (isTargetLive && applyMode && !understandLive) {
  console.error('SAFETY STOP: Refusing to apply changes to the LIVE database without --i-understand-live.');
  console.error(`Target resolved to live DB: ${targetPath}`);
  process.exit(1);
}

console.log(`=== Agent ID Normalization Utility ===`);
console.log(`Target Database: ${targetPath}`);
console.log(`Mode:            ${applyMode ? 'APPLY (Mutating)' : 'DRY RUN (Read-Only)'}`);
console.log(`Target Is Live:  ${isTargetLive}`);

const db = new DatabaseSync(targetPath);

const COLUMNS_TO_CHECK = [
  { table: 'tasks', idCol: 'id', cols: ['to_agent', 'from_agent'] },
  { table: 'bridge_requests', idCol: 'request_id', cols: ['to_agent', 'from_agent'] },
  { table: 'messages', idCol: 'id', cols: ['to_agent', 'from_agent'] },
  { table: 'bridge_events', idCol: 'event_id', cols: ['agent_id', 'from_agent'] }
];

function tableExists(tableName) {
  const row = db.prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name = ?").get(tableName);
  return row?.cnt > 0;
}

const plannedUpdates = [];

for (const { table, idCol, cols } of COLUMNS_TO_CHECK) {
  if (!tableExists(table)) continue;

  const tableCols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

  for (const col of cols) {
    if (!tableCols.includes(col)) continue;

    for (const [alias, canonical] of Object.entries(AGENT_ALIASES)) {
      if (alias === canonical) continue; // Skip identical mappings

      const rows = db.prepare(`SELECT ${idCol} as id, ${col} as val FROM ${table} WHERE LOWER(${col}) = ?`).all(alias.toLowerCase());
      for (const row of rows) {
        plannedUpdates.push({
          table,
          idCol,
          id: row.id,
          col,
          oldVal: row.val,
          newVal: canonical
        });
      }
    }
  }
}

console.log(`\nFound ${plannedUpdates.length} row(s) with non-canonical aliases.`);

for (const up of plannedUpdates) {
  console.log(`  [${up.table}] Row ${up.idCol}=${up.id}: ${up.col} '${up.oldVal}' -> '${up.newVal}'`);
}

if (!applyMode) {
  console.log('\nDRY RUN complete. No changes were written. Re-run with --apply to execute.');
  db.close();
  process.exit(0);
}

if (plannedUpdates.length === 0) {
  console.log('\nNo updates needed. Database is already fully canonical.');
  db.close();
  process.exit(0);
}

console.log('\nApplying updates inside transaction...');
db.exec('BEGIN IMMEDIATE TRANSACTION;');
try {
  let appliedCount = 0;
  for (const up of plannedUpdates) {
    const res = db.prepare(`UPDATE ${up.table} SET ${up.col} = ? WHERE ${up.idCol} = ?`).run(up.newVal, up.id);
    appliedCount += res.changes;
  }
  db.exec('COMMIT;');
  console.log(`Successfully normalized ${appliedCount} row(s) to canonical identities.`);
} catch (err) {
  try { db.exec('ROLLBACK;'); } catch {}
  console.error(`Failed to apply normalization: ${err.message}`);
  db.close();
  process.exit(1);
}

db.close();
