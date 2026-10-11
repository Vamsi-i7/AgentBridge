/**
 * UI Polling CPU & Overlap Guard Measurement Script (P9 Remediation)
 *
 * Measures:
 * 1. CPU consumption of adaptive polling (active streaming vs. idle backoff)
 * 2. Projected CPU seconds per hour
 * 3. Proves strict non-overlap: zero concurrent in-flight polls
 */

import { NativeAxAdapter } from '../../src/control-plane/native-ax-adapter.js';

class MockSwiftAXBridge {
  constructor() {
    this.pollCount = 0;
    this.concurrentCount = 0;
    this.maxConcurrent = 0;
    this.simulatedWorkload = 'idle'; // 'idle', 'streaming'
    this.ticks = 0;
  }

  isBinaryAvailable() { return true; }
  async inspectApp() { return { ok: true, running: true, pid: 1234 }; }

  async observeResponse(appName, requestId, timeoutMs) {
    this.concurrentCount++;
    if (this.concurrentCount > this.maxConcurrent) {
      this.maxConcurrent = this.concurrentCount;
    }
    this.pollCount++;
    this.ticks++;

    // Simulate work taking 15ms
    await new Promise(r => setTimeout(r, 15));
    this.concurrentCount--;

    if (this.simulatedWorkload === 'streaming') {
      return {
        ok: true,
        response: 'Streaming token chunk ' + this.ticks,
        isGenerating: true,
        stopButtonPresent: true
      };
    } else {
      return {
        ok: true,
        response: '',
        isGenerating: false,
        stopButtonPresent: false
      };
    }
  }
}

async function measureIntervalProfile(workload, durationMs) {
  const bridge = new MockSwiftAXBridge();
  bridge.simulatedWorkload = workload;

  const adapter = new NativeAxAdapter({
    appName: 'MockChatGPT',
    swiftBridge: bridge,
    pollIntervalMs: 100
  });

  const cpuStart = process.cpuUsage();
  const timeStart = Date.now();

  const handle = adapter.observe({ requestId: `req_bench_${workload}`, timeoutMs: durationMs * 2 });

  await new Promise(r => setTimeout(r, durationMs));
  await handle.cancel();

  const elapsedMs = Date.now() - timeStart;
  const cpuDiff = process.cpuUsage(cpuStart);
  const totalCpuMicroseconds = cpuDiff.user + cpuDiff.system;
  const cpuPercent = (totalCpuMicroseconds / (elapsedMs * 1000)) * 100;
  const projectedCpuSecondsPerHour = ((totalCpuMicroseconds / 1e6) / (elapsedMs / 1000)) * 3600;

  return {
    workload,
    elapsedMs,
    pollCount: bridge.pollCount,
    maxConcurrentPolls: bridge.maxConcurrent,
    cpuPercent: Number(cpuPercent.toFixed(2)),
    projectedCpuSecondsPerHour: Number(projectedCpuSecondsPerHour.toFixed(2))
  };
}

export async function runUiPollBenchmark() {
  const idle = await measureIntervalProfile('idle', 1500);
  const streaming = await measureIntervalProfile('streaming', 1500);

  return {
    idle,
    streaming,
    overlapGuardMaintained: idle.maxConcurrentPolls <= 1 && streaming.maxConcurrentPolls <= 1,
    justification: {
      fastIntervalMs: 100,
      normalIntervalMs: 300,
      idleIntervalMs: 600,
      rationale: '100ms during active generation ensures <100ms streaming text latency; 600ms during idle drops CPU usage to <0.5%, with an overlap guard ensuring slow AX calls never pile up.'
    }
  };
}

if (process.argv[1] && process.argv[1].endsWith('ui-poll-cost-measurement.js')) {
  runUiPollBenchmark().then(res => {
    console.log('='.repeat(70));
    console.log('UI POLL COST & ADAPTIVE INTERVAL MEASUREMENT (P9)');
    console.log('='.repeat(70));
    console.log(`Idle Workload (600ms backoff):`);
    console.log(`  Poll Count (1.5s):        ${res.idle.pollCount}`);
    console.log(`  CPU Usage:                ${res.idle.cpuPercent}%`);
    console.log(`  Projected CPU/hour:       ${res.idle.projectedCpuSecondsPerHour}s`);
    console.log(`  Max Concurrent Polls:     ${res.idle.maxConcurrentPolls} (Must be <= 1)`);
    console.log(`Streaming Workload (100ms active):`);
    console.log(`  Poll Count (1.5s):        ${res.streaming.pollCount}`);
    console.log(`  CPU Usage:                ${res.streaming.cpuPercent}%`);
    console.log(`  Projected CPU/hour:       ${res.streaming.projectedCpuSecondsPerHour}s`);
    console.log(`  Max Concurrent Polls:     ${res.streaming.maxConcurrentPolls} (Must be <= 1)`);
    console.log(`Overlap Guard Maintained:   ${res.overlapGuardMaintained ? 'YES' : 'NO'}`);
    console.log('='.repeat(70));
  });
}
