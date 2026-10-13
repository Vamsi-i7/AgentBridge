#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '..', 'src');
const DOCS_OUTPUT = path.resolve(__dirname, '..', 'docs', 'silent-catch-inventory.md');

function getAllJsFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(getAllJsFiles(fullPath));
    } else if (file.endsWith('.js')) {
      results.push(fullPath);
    }
  }
  return results;
}

export function auditSilentCatches() {
  const files = getAllJsFiles(SRC_DIR);
  const catches = [];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    const relPath = path.relative(path.resolve(__dirname, '..'), file);

    // Regex for catch blocks
    // Matches `catch` followed by optional `(err)` and `{`
    const catchRegex = /catch(?:\s*\([^)]*\))?\s*\{([^}]*)\}/g;
    let match;

    while ((match = catchRegex.exec(content)) !== null) {
      const body = match[1].trim();
      const beforeMatch = content.slice(0, match.index);
      const lineNum = beforeMatch.split('\n').length;
      const precedingLine = lineNum > 1 ? lines[lineNum - 2].trim() : '';
      const currentLine = lines[lineNum - 1];

      const hasSwallowOk = body.includes('swallow-ok') ||
                           currentLine.includes('swallow-ok') ||
                           precedingLine.includes('swallow-ok');

      const isEmpty = body.length === 0 || body === '/* swallow-ok */' || /^\/\/[^\n]*$/.test(body);
      const hasLog = /(?:this\.)?logger\??\.(debug|warn|error|log)|console\.(debug|warn|error|log)|this\._log|this\.emit\('error'/.test(body);
      const hasThrow = /throw\s+|reject\(/.test(body);
      const hasReturn = /return\b/.test(body);

      let classification = 'B'; // default: needs logging
      let rationale = '';

      if (hasThrow) {
        classification = 'C';
        rationale = 'Rethrows or rejects with error';
      } else if (hasLog) {
        classification = 'A';
        rationale = 'Logged to logger, console, or emitted as error';
      } else if (hasSwallowOk) {
        classification = 'A';
        rationale = 'Explicitly reviewed with swallow-ok justification';
      } else if (hasReturn) {
        classification = 'A';
        rationale = 'Handled via safe default/fallback return';
      } else if (
        /close\(\)|unlinkSync|rmSync|clearTimeout|clearInterval/.test(body) ||
        /try\s*\{\s*JSON\.parse/.test(currentLine)
      ) {
        classification = 'A';
        rationale = 'Cleanup or safe parser fallback';
      } else if (isEmpty) {
        classification = 'B';
        rationale = 'Completely silent bare catch';
      } else {
        classification = 'B';
        rationale = 'Silent failure without logging or propagation';
      }

      catches.push({
        file: relPath,
        line: lineNum,
        bodySnippet: body.replace(/\s+/g, ' ').slice(0, 60),
        classification,
        hasSwallowOk,
        hasLog,
        hasThrow,
        rationale
      });
    }
  }

  return catches;
}

export function generateReport(catches) {
  const classA = catches.filter(c => c.classification === 'A');
  const classB = catches.filter(c => c.classification === 'B');
  const classC = catches.filter(c => c.classification === 'C');

  let md = `# Agent Bridge — Silent Catch Inventory & Audit (AR-08 / AR-14)\n\n`;
  md += `**Date:** ${new Date().toISOString()} · **Scope:** \`src/\` (${catches.length} total catch blocks analyzed)\n\n`;
  md += `## Summary Classification\n\n`;
  md += `| Class | Description | Count |\n`;
  md += `|---|---|---|\n`;
  md += `| **Class A** | Acceptable cleanup, safe fallback, or documented with \`swallow-ok\` | ${classA.length} |\n`;
  md += `| **Class B** | Silent catch requiring logging / observability remediation | ${classB.length} |\n`;
  md += `| **Class C** | Critical path rethrowing or propagating | ${classC.length} |\n\n`;

  md += `## Remediation Policy\n\n`;
  md += `1. **Class B Remediation**: In core runtime engines (\`schema-migrator\`, \`mailbox-hub\`, \`task-manager\`, \`audit-logger\`), bare catches must either:\n`;
  md += `   - Log at \`debug\` or \`warn\` level with structured context via \`this.logger?.debug?.(...)\` or \`this.logger?.log?.(...)\`.\n`;
  md += `   - Include an explicit \`// swallow-ok: <specific reason>\` comment explaining why ignoring the error is strictly required and safe.\n`;
  md += `2. **Lint Enforcement**: \`tests/silent-catch-lint.test.js\` enforces that no unreviewed bare \`catch {}\` exists in \`src/\`.\n\n`;

  md += `## Inventory\n\n`;
  md += `| File | Line | Class | Snippet | Rationale |\n`;
  md += `|---|---|---|---|---|\n`;
  for (const c of catches) {
    md += `| \`${c.file}\` | ${c.line} | **${c.classification}** | \`${c.bodySnippet || '{}'}\` | ${c.rationale} |\n`;
  }

  return md;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catches = auditSilentCatches();
  const md = generateReport(catches);
  fs.writeFileSync(DOCS_OUTPUT, md, 'utf8');
  console.log(`Audited ${catches.length} catch sites across src/. Report written to ${DOCS_OUTPUT}`);
  console.log(`Class A: ${catches.filter(c => c.classification === 'A').length}`);
  console.log(`Class B: ${catches.filter(c => c.classification === 'B').length}`);
  console.log(`Class C: ${catches.filter(c => c.classification === 'C').length}`);
}
