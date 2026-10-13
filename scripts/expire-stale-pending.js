#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG } from '../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DB_PATH = path.resolve(__dirname, '..', 'data', 'bridge.sqlite');

function printUsage() {
  console.log(`
Usage: node scripts/expire-stale-pending.js [options]

Options:
  --db <path>              Path to SQLite database (default: data/bridge.sqlite)
  --max-age-hours <hours>  Expiry threshold in hours (default: 24)
  --apply                  Execute state transition (default: dry-run only)
  --i-understand-live      Required safety flag to apply changes against live DB
  --json                   Output results as JSON
  --help, -h               Show this help message
`);
}

export function runExpireStalePending(args = process.argv.slice(2)) {
  let dbPath = DEFAULT_DB_PATH;
  let maxAgeHours = 24;
  let apply = false;
  let understandLive = false;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--db' && i + 1 < args.length) {
      dbPath = path.resolve(args[++i]);
    } else if (arg === '--max-age-hours' && i + 1 < args.length) {
      maxAgeHours = parseFloat(args[++i]);
    } else if (arg === '--apply') {
      apply = true;
    } else if (arg === '--i-understand-live') {
      understandLive = true;
    } else if (arg === '--json') {
      jsonOutput = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  if (!fs.existsSync(dbPath)) {
    console.error(`Error: Database not found at ${dbPath}`);
    process.exit(1);
  }

  const isLiveDb = path.resolve(dbPath) === path.resolve(CONFIG.DB_PATH) ||
                   path.resolve(dbPath) === path.resolve(DEFAULT_DB_PATH);

  if (apply && isLiveDb && !understandLive) {
    console.error('SAFETY ERROR: Refusing to apply changes to production database without --i-understand-live');
    process.exit(1);
  }

  const db = new DatabaseSync(dbPath);
  const cutoffMs = Date.now() - (maxAgeHours * 60 * 60 * 1000);
  const cutoffIso = new Date(cutoffMs).toISOString();

  // Find stale pending requests
  const staleRequests = db.prepare(`
    SELECT request_id, created_at, from_agent, to_agent, question, status
    FROM bridge_requests
    WHERE status = 'pending' AND created_at IS NOT NULL AND created_at < ?
    ORDER BY created_at ASC
  `).all(cutoffIso);

  // Find stale pending tasks
  const staleTasks = db.prepare(`
    SELECT id, created_at, from_agent, to_agent, title, status
    FROM tasks
    WHERE status = 'pending' AND created_at IS NOT NULL AND created_at < ?
    ORDER BY created_at ASC
  `).all(cutoffIso);

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    dbPath,
    maxAgeHours,
    cutoffIso,
    requestsCount: staleRequests.length,
    tasksCount: staleTasks.length,
    requests: staleRequests.map(r => ({
      requestId: r.request_id,
      createdAt: r.created_at,
      fromAgent: r.from_agent,
      toAgent: r.to_agent,
      ageHours: ((Date.now() - Date.parse(r.created_at)) / (1000 * 60 * 60)).toFixed(1)
    })),
    tasks: staleTasks.map(t => ({
      taskId: t.id,
      createdAt: t.created_at,
      fromAgent: t.from_agent,
      toAgent: t.to_agent,
      title: t.title,
      ageHours: ((Date.now() - Date.parse(t.created_at)) / (1000 * 60 * 60)).toFixed(1)
    }))
  };

  if (!apply) {
    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`=== Stale Pending Work Audit (DRY-RUN) ===`);
      console.log(`Database: ${dbPath}`);
      console.log(`Max Age: ${maxAgeHours} hours (cutoff: ${cutoffIso})`);
      console.log(`\nStale Pending Requests (${staleRequests.length}):`);
      for (const r of report.requests) {
        console.log(`  - [${r.requestId}] from: ${r.fromAgent} -> to: ${r.toAgent} (age: ${r.ageHours}h, created: ${r.createdAt})`);
      }
      console.log(`\nStale Pending Tasks (${staleTasks.length}):`);
      for (const t of report.tasks) {
        console.log(`  - [${t.taskId}] from: ${t.fromAgent} -> to: ${t.toAgent} title: "${t.title}" (age: ${t.ageHours}h, created: ${t.createdAt})`);
      }
      console.log(`\nSummary: ${staleRequests.length} requests and ${staleTasks.length} tasks eligible for expiry.`);
      console.log(`To apply changes, pass --apply (and --i-understand-live if targeting production DB).`);
    }
    db.close();
    return report;
  }

  // Apply changes in immediate transaction
  const now = new Date().toISOString();
  let updatedRequests = 0;
  let updatedTasks = 0;

  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const r of staleRequests) {
      const errorMsg = `TARGET_UNREACHABLE: Request expired in pending state without being claimed after ${maxAgeHours}h (created at ${r.created_at}).`;
      const res = db.prepare(`
        UPDATE bridge_requests
        SET status = 'failed',
            delivery_state = 'PENDING_EXPIRED',
            error = ?,
            updated_at = ?
        WHERE request_id = ? AND status = 'pending'
      `).run(errorMsg, now, r.request_id);
      if (res.changes > 0) updatedRequests++;
    }

    for (const t of staleTasks) {
      const errorMsg = `TARGET_UNREACHABLE: Task expired in pending state without being claimed after ${maxAgeHours}h (created at ${t.created_at}).`;
      const res = db.prepare(`
        UPDATE tasks
        SET status = 'failed',
            error = ?,
            updated_at = ?,
            completed_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(errorMsg, now, now, t.id);
      if (res.changes > 0) updatedTasks++;
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    db.close();
    console.error('Transaction failed, rolled back:', err);
    process.exit(1);
  }

  db.close();

  report.applied = {
    updatedRequests,
    updatedTasks
  };

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`=== Stale Pending Work Expired (APPLIED) ===`);
    console.log(`Expired ${updatedRequests} requests and ${updatedTasks} tasks.`);
  }

  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runExpireStalePending();
}
