import fs from 'node:fs';
import path from 'node:path';
import { ToolRegistry } from '../src/tool-registry.js';
import {
  getToolClassification,
  getToolSecurityCategory,
  ToolSecurityCategory
} from '../src/effects/effects-ledger.js';

export function generateAuditTable(baseDir = process.cwd()) {
  const reg = new ToolRegistry();
  const toolNames = Array.from(reg.tools.keys()).sort();
  const testDir = path.join(baseDir, 'tests');
  const testFiles = fs.existsSync(testDir)
    ? fs.readdirSync(testDir).filter(f => f.endsWith('.test.js')).map(f => path.join('tests', f))
    : [];

  const rows = [];
  for (const name of toolNames) {
    const effectCls = getToolClassification(name);
    const secCategory = getToolSecurityCategory(name);
    const mutates = [
      ToolSecurityCategory.WORKSPACE_MUTATING,
      ToolSecurityCategory.SYSTEM_EXECUTING,
      ToolSecurityCategory.STATEFUL_MESSAGING
    ].includes(secCategory);

    let whoseData = 'caller / local';
    if (secCategory === ToolSecurityCategory.CROSS_AGENT_DATA) whoseData = 'peer / cross-agent';
    else if (secCategory === ToolSecurityCategory.WORKSPACE_READ || secCategory === ToolSecurityCategory.WORKSPACE_MUTATING) whoseData = 'workspace filesystem / git';
    else if (secCategory === ToolSecurityCategory.SYSTEM_EXECUTING) whoseData = 'host system execution';
    else if (name === 'bridge_diagnostics' || name === 'bridge_get_adapter_capabilities') whoseData = 'runtime metadata';
    else if (name === 'bridge_discover_agents' || name === 'bridge_agent_presence') whoseData = 'agent catalog';

    const authReq = secCategory !== ToolSecurityCategory.PURE_LOCAL || name === 'bridge_diagnostics';
    const identSource = authReq ? 'trusted transport / context' : 'optional / public';

    let coveringTest = 'tests/tool-matrix.test.js';
    for (const tf of testFiles) {
      const fullPath = path.join(baseDir, tf);
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes(`'${name}'`) || content.includes(`"${name}"`)) {
        coveringTest = tf;
        break;
      }
    }

    rows.push({
      name,
      effectClassification: effectCls,
      securityCategory: secCategory,
      mutatesState: mutates ? 'YES' : 'NO',
      whoseData,
      identitySource: identSource,
      authRequired: authReq ? 'YES' : 'NO',
      coveringTest
    });
  }

  return rows;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const rows = generateAuditTable();
  console.log('| Tool Name | Effect Classification | Security Category | Mutates State? | Whose Data Returned | Identity Source | Auth Required? | Test That Covers It |');
  console.log('| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
  for (const r of rows) {
    console.log(`| \`${r.name}\` | \`${r.effectClassification}\` | \`${r.securityCategory}\` | ${r.mutatesState} | ${r.whoseData} | ${r.identitySource} | ${r.authRequired} | [\`${r.coveringTest}\`](file:///${path.resolve(r.coveringTest)}) |`);
  }
}
