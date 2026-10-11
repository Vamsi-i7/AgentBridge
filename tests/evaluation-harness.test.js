import test from 'node:test';
import assert from 'node:assert/strict';
import { RealWorldEvaluationHarness, EVAL_TASKS } from '../src/cli/evaluate.js';

test('Real-World Evaluation Harness Unit Test Suite [TEST-PROVEN]', async (t) => {
  await t.test('1. Evaluation tasks are defined with deterministic validators', () => {
    assert.strictEqual(EVAL_TASKS.length, 5);
    for (const task of EVAL_TASKS) {
      assert.ok(task.id);
      assert.ok(task.name);
      assert.strictEqual(typeof task.check, 'function');
    }
  });

  await t.test('2. Harness executes paired comparison in offline fake CLI mode', async () => {
    const harness = new RealWorldEvaluationHarness({ repetitions: 1 });
    const report = await harness.runEvaluation();

    assert.strictEqual(report.mode, 'OFFLINE_FAKE_CLI');
    assert.strictEqual(report.tasksEvaluated, 5);
    assert.strictEqual(report.results.length, 5);

    for (const r of report.results) {
      assert.ok(typeof r.tokenChangePct === 'number');
      assert.ok(['KEEP DEFAULT-ON', 'OPT-IN (Neutral / Overhead)', 'REMOVE (Accuracy Regression)'].includes(r.conclusion));
    }

    const formatted = harness.formatReport(report);
    assert.ok(formatted.includes('AGENT BRIDGE REAL-WORLD EVALUATION HARNESS REPORT'));
  });
});
