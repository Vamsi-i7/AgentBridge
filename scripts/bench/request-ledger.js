#!/usr/bin/env node
/**
 * Agent Bridge Request Lifecycle Ledger Diagnostic CLI
 *
 * Usage:
 *   node scripts/bench/request-ledger.js <requestId>
 *   node scripts/bench/request-ledger.js --latest
 */

import { AuditLogger } from '../../src/audit-logger.js';
import { RequestTracer } from '../../src/diagnostics/request-tracer.js';
import { RequestExplainer } from '../../src/diagnostics/request-explainer.js';
import { CONFIG } from '../../src/config.js';

async function main() {
  const args = process.argv.slice(2);
  const dbPath = process.env.AGENT_BRIDGE_DB_PATH || CONFIG.DB_PATH;
  const logger = new AuditLogger(dbPath);
  const tracer = new RequestTracer(logger);
  const explainer = new RequestExplainer(logger);

  let targetRequestId = args.find(a => !a.startsWith('--'));

  if (!targetRequestId || args.includes('--latest')) {
    const latest = logger.db.prepare(`
      SELECT request_id, status, created_at FROM request_ledgers
      ORDER BY updated_at DESC LIMIT 5
    `).all();

    if (!latest || latest.length === 0) {
      console.log('No requests found in request ledger.');
      logger.close();
      return;
    }

    if (!targetRequestId) {
      targetRequestId = latest[0].request_id;
      console.log(`No requestId specified. Showing most recent: ${targetRequestId}\n`);
    }
  }

  const ledger = tracer.getLedger(targetRequestId);
  if (!ledger) {
    const expl = explainer.explainRequest(targetRequestId);
    if (!expl.found) {
      console.error(`Request '${targetRequestId}' not found in database.`);
      logger.close();
      process.exit(1);
    }
    console.log(`Ledger not found for '${targetRequestId}', but request exists:`);
    console.log(JSON.stringify(expl, null, 2));
    logger.close();
    return;
  }

  console.log(tracer.formatLedgerText(ledger));

  if (args.includes('--json')) {
    console.log('\n--- RAW JSON LEDGER ---');
    console.log(JSON.stringify(ledger, null, 2));
  }

  logger.close();
}

main().catch(err => {
  console.error('Fatal error in request-ledger CLI:', err);
  process.exit(1);
});
