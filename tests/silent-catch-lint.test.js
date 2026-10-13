import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '..', 'src');
const INVENTORY_FILE = path.resolve(__dirname, '..', 'docs', 'silent-catch-inventory.md');

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

test('Stage 5 — Silent Catch Lint & Inventory Suite (AR-08 / AR-14)', async (t) => {
  await t.test('1. Zero undocumented bare catch blocks exist in src/', () => {
    const files = getAllJsFiles(SRC_DIR);
    const violations = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      const relPath = path.relative(path.resolve(__dirname, '..'), file);

      // Matches catch (...) {} or catch {} where body contains no code and no swallow-ok
      const catchRegex = /catch(?:\s*\([^)]*\))?\s*\{([^}]*)\}/g;
      let match;

      while ((match = catchRegex.exec(content)) !== null) {
        const body = match[1].trim();
        const beforeMatch = content.slice(0, match.index);
        const lineNum = beforeMatch.split('\n').length;
        const currentLine = lines[lineNum - 1];
        const precedingLine = lineNum > 1 ? lines[lineNum - 2].trim() : '';

        const hasSwallowOk = body.includes('swallow-ok') ||
                             currentLine.includes('swallow-ok') ||
                             precedingLine.includes('swallow-ok');

        const isEmpty = body.length === 0;

        if (isEmpty && !hasSwallowOk) {
          violations.push({
            file: relPath,
            line: lineNum,
            snippet: match[0]
          });
        }
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      `Found ${violations.length} bare catch block(s) without // swallow-ok in src/:\n` +
      violations.map(v => `  - ${v.file}:${v.line} -> ${v.snippet}`).join('\n')
    );
  });

  await t.test('2. Every swallow-ok annotation provides a non-empty descriptive reason', () => {
    const files = getAllJsFiles(SRC_DIR);
    const invalidAnnotations = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      const relPath = path.relative(path.resolve(__dirname, '..'), file);

      lines.forEach((line, idx) => {
        if (line.includes('swallow-ok')) {
          const match = line.match(/swallow-ok\s*:\s*(.*)/);
          if (!match || !match[1].trim() || match[1].trim() === 'ok' || match[1].trim() === 'true') {
            invalidAnnotations.push({ file: relPath, line: idx + 1, text: line.trim() });
          }
        }
      });
    }

    assert.strictEqual(
      invalidAnnotations.length,
      0,
      `Found ${invalidAnnotations.length} swallow-ok comment(s) without descriptive reason:\n` +
      invalidAnnotations.map(v => `  - ${v.file}:${v.line} -> ${v.text}`).join('\n')
    );
  });

  await t.test('3. Silent catch inventory documentation exists and is populated', () => {
    assert.ok(fs.existsSync(INVENTORY_FILE), 'docs/silent-catch-inventory.md must exist');
    const content = fs.readFileSync(INVENTORY_FILE, 'utf8');
    assert.ok(content.includes('Silent Catch Inventory & Audit'));
    assert.ok(content.includes('Class A'));
    assert.ok(content.includes('Class B'));
    assert.ok(content.includes('Class C'));
    assert.ok(content.length > 5000, 'Inventory document must contain full catalog');
  });
});
