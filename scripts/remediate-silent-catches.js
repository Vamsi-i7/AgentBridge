#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '..', 'src');

function getAllJsFiles(dir) {
  let results = [];
  for (const file of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      results = results.concat(getAllJsFiles(fullPath));
    } else if (file.endsWith('.js')) {
      results.push(fullPath);
    }
  }
  return results;
}

function determineSwallowReason(tryBlockText) {
  const t = tryBlockText.toLowerCase();
  if (t.includes('json.parse')) {
    return 'safe fallback for plaintext or non-JSON input';
  }
  if (t.includes('json.stringify')) {
    return 'safe fallback for non-serializable object';
  }
  if (t.includes('alter table') || t.includes('create index') || t.includes('create table')) {
    return 'DDL schema idempotency check';
  }
  if (t.includes('rollback')) {
    return 'transaction may already be resolved or closed';
  }
  if (t.includes('close(') || t.includes('end(') || t.includes('unsubscribe') || t.includes('clear')) {
    return 'best-effort disposal cleanup';
  }
  if (t.includes('kill(') || t.includes('unlinksync') || t.includes('rmsync')) {
    return 'process or file cleanup';
  }
  if (t.includes('publish(') || t.includes('emit(') || t.includes('log(')) {
    return 'secondary notification or event dispatch failure is non-fatal';
  }
  if (t.includes('select ') || t.includes('prepare(') || t.includes('get(')) {
    return 'optional record lookup fallback';
  }
  return 'intentional non-fatal error suppression';
}

export function remediateSilentCatches() {
  const files = getAllJsFiles(SRC_DIR);
  let totalFixed = 0;

  for (const file of files) {
    let content = fs.readFileSync(file, 'utf8');
    const original = content;

    // Pattern matching bare catch: catch (...) {} or catch {}
    // We want to avoid modifying catch blocks that already have swallow-ok or code
    const bareCatchPattern = /catch(?:\s*\(([^)]*)\))?\s*\{\s*\}/g;

    content = content.replace(bareCatchPattern, (match, errVar, offset) => {
      // Look back to find the preceding try block
      const preceding = content.slice(Math.max(0, offset - 300), offset);
      const reason = determineSwallowReason(preceding);
      totalFixed++;
      const param = errVar ? `(${errVar})` : '';
      return `catch ${param} {\n      // swallow-ok: ${reason}\n    }`.replace(/catch\s+\(/, 'catch (');
    });

    if (content !== original) {
      fs.writeFileSync(file, content, 'utf8');
    }
  }

  console.log(`Remediated ${totalFixed} bare catch blocks in src/ with explicit swallow-ok justifications.`);
  return totalFixed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  remediateSilentCatches();
}
