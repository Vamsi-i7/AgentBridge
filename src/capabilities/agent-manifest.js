import fs from 'node:fs';
import path from 'node:path';

/**
 * Presence State Classification (Mission D)
 * Clearly separates registration, connectivity, idle readiness, and permission capability.
 */
export const PresenceState = Object.freeze({
  REGISTERED: 'REGISTERED',   // Known to system configuration / manifest
  CONNECTED: 'CONNECTED',     // Transport connected (active IPC / stdio / socket)
  READY: 'READY',             // Idle and able to accept new chat turn
  CAPABLE: 'CAPABLE'          // Possesses required tools & permissions for the task
});

/**
 * Route Evidence Classification
 * Tracks the empirical verification tier of each route.
 * A route is declared until a probe or mock/live test proves it.
 */
export const RouteEvidence = Object.freeze({
  DECLARED: 'declared',
  PROBED: 'probed',
  MOCK_TESTED: 'mock-tested',
  LIVE_VERIFIED: 'live-verified'
});

/**
 * Route Types and Capabilities
 */
export const RouteType = Object.freeze({
  MCP: 'mcp',
  CDP: 'cdp',
  LOCAL_ENGINE: 'local_engine',
  HEADLESS_CLI: 'headless_cli',
  ACCESSIBILITY_UI: 'accessibility_ui'
});

/**
 * Declarative Agent Manifests
 * Every agent is pure data. No hardcoded `if agent === ...` branching in core routing.
 */
export const AGENT_MANIFESTS = Object.freeze({
  'chatgpt-desktop': {
    agentId: 'chatgpt-desktop',
    displayName: 'ChatGPT Desktop',
    appType: 'native_macos',
    bundleId: 'com.openai.chat',
    appName: 'ChatGPT',
    routes: [
      { id: 'desktop-ui-ax', priority: 1, type: RouteType.ACCESSIBILITY_UI, capabilities: ['background_window', 'native_ax'], evidence: RouteEvidence.MOCK_TESTED, backgroundCapable: 'mock-proven' },
      { id: 'chatgpt-local-engine', priority: 2, type: RouteType.LOCAL_ENGINE, capabilities: ['cli', 'structured_stream', 'background'], evidence: RouteEvidence.MOCK_TESTED, backgroundCapable: 'mock-proven' },
      { id: 'mcp-stdio', priority: 3, type: RouteType.MCP, capabilities: ['bidirectional', 'exact_turn'], evidence: RouteEvidence.MOCK_TESTED, backgroundCapable: 'mock-proven' },
      { id: 'cdp-unverified', priority: 99, type: RouteType.CDP, capabilities: ['experimental'], evidence: RouteEvidence.DECLARED, backgroundCapable: 'declared', unverified: true, notes: 'ChatGPT macOS is native AppKit/Swift, not Electron. CDP requires proven debuggable webview.' }
    ],
    fallbackChain: ['desktop-ui-ax', 'chatgpt-local-engine', 'mcp-stdio'],
    maxConcurrency: 1,
    headlessCliSupported: true,
    cdpSupported: false
  },
  'claude-desktop': {
    agentId: 'claude-desktop',
    displayName: 'Claude Desktop',
    appType: 'electron',
    bundleId: 'com.anthropic.claudefordesktop',
    appName: 'Claude',
    routes: [
      { id: 'mcp-stdio', priority: 1, type: RouteType.MCP, capabilities: ['bidirectional', 'exact_turn'], evidence: RouteEvidence.MOCK_TESTED, backgroundCapable: 'mock-proven' },
      { id: 'cdp-electron', priority: 2, type: RouteType.CDP, capabilities: ['dom_inject', 'network_stream', 'background_minimized'], evidence: RouteEvidence.MOCK_TESTED, backgroundCapable: 'mock-proven' },
      { id: 'desktop-ui-ax', priority: 3, type: RouteType.ACCESSIBILITY_UI, capabilities: ['background_window', 'fallback'], evidence: RouteEvidence.MOCK_TESTED, backgroundCapable: 'mock-proven' }
    ],
    fallbackChain: ['mcp-stdio', 'cdp-electron', 'desktop-ui-ax'],
    maxConcurrency: 1,
    headlessCliSupported: true,
    cdpSupported: true
  },
  'antigravity-ide': {
    agentId: 'antigravity-ide',
    displayName: 'Antigravity IDE',
    appType: 'electron',
    bundleId: 'com.google.antigravity',
    appName: 'Antigravity',
    routes: [
      { id: 'mcp-stdio', priority: 1, type: RouteType.MCP, capabilities: ['bidirectional', 'exact_turn', 'in_process'], evidence: RouteEvidence.MOCK_TESTED, backgroundCapable: 'mock-proven' },
      { id: 'cdp-electron', priority: 2, type: RouteType.CDP, capabilities: ['dom_inject', 'background'], evidence: RouteEvidence.MOCK_TESTED, backgroundCapable: 'mock-proven' }
    ],
    fallbackChain: ['mcp-stdio', 'cdp-electron'],
    maxConcurrency: 4,
    headlessCliSupported: true,
    cdpSupported: true
  },
  'gemini': {
    agentId: 'gemini',
    displayName: 'Gemini CLI / Web',
    appType: 'cli_and_web',
    bundleId: 'com.google.gemini',
    appName: 'Gemini',
    routes: [
      { id: 'mcp-stdio', priority: 1, type: RouteType.MCP, capabilities: ['bidirectional', 'exact_turn'], evidence: RouteEvidence.MOCK_TESTED, backgroundCapable: 'mock-proven' },
      { id: 'headless-cli', priority: 2, type: RouteType.HEADLESS_CLI, capabilities: ['cli_print', 'exact_turn', 'background'], evidence: RouteEvidence.MOCK_TESTED, backgroundCapable: 'mock-proven' },
      { id: 'desktop-ui-ax', priority: 3, type: RouteType.ACCESSIBILITY_UI, capabilities: ['background_window', 'fallback'], evidence: RouteEvidence.MOCK_TESTED, backgroundCapable: 'mock-proven' }
    ],
    fallbackChain: ['mcp-stdio', 'headless-cli', 'desktop-ui-ax'],
    maxConcurrency: 2,
    headlessCliSupported: true,
    cdpSupported: false
  },
  'freebuff': {
    agentId: 'freebuff',
    displayName: 'Freebuff Protocol Worker',
    appType: 'service',
    bundleId: null,
    appName: null,
    routes: [
      { id: 'mcp-stdio', priority: 1, type: RouteType.MCP, capabilities: ['bidirectional', 'exact_turn', 'in_process'], evidence: RouteEvidence.MOCK_TESTED, backgroundCapable: 'mock-proven' }
    ],
    fallbackChain: ['mcp-stdio'],
    maxConcurrency: 8,
    headlessCliSupported: true,
    cdpSupported: false
  }
});

/**
 * Manifest Resolver
 */
export function getAgentManifest(agentId) {
  if (!agentId || typeof agentId !== 'string') return null;
  const norm = agentId.trim().toLowerCase();
  return AGENT_MANIFESTS[norm] || null;
}

export function getAgentAppName(agentId, fallback = 'Desktop Application') {
  const manifest = getAgentManifest(agentId);
  return manifest?.appName || fallback;
}

export function getAgentBundleId(agentId) {
  const manifest = getAgentManifest(agentId);
  return manifest?.bundleId || null;
}

export function getAgentFallbackChain(agentId) {
  const manifest = getAgentManifest(agentId);
  return manifest?.fallbackChain || ['mcp-stdio'];
}

/**
 * Canary Route Prober
 * Actively tests route health. If a route fails or is broken by an app update,
 * it is marked degraded with a diagnostic reason. Never silently substitutes agents.
 */
export class CanaryRouteProber {
  constructor() {
    this.routeStatus = new Map(); // routeKey -> { status: 'healthy'|'degraded'|'disabled', reason, lastProbed }
  }

  recordProbe(routeKey, { healthy, reason = null }) {
    this.routeStatus.set(routeKey, {
      status: healthy ? 'healthy' : 'degraded',
      reason,
      lastProbed: new Date().toISOString()
    });
  }

  getRouteHealth(routeKey) {
    return this.routeStatus.get(routeKey) || { status: 'healthy', reason: null, lastProbed: null };
  }

  isRouteAvailable(routeKey) {
    const record = this.routeStatus.get(routeKey);
    return !record || record.status === 'healthy';
  }
}

/**
 * Read-Only Audit for Hardcoded Agent Branches
 * Audits files to ensure routing decisions are made via manifests rather than hardcoded names.
 */
export function auditHardcodedAgentBranches(rootDir = process.cwd()) {
  const filesToCheck = [
    'src/session-adapters/index.js',
    'src/control-plane/desktop-control-plane.js'
  ];

  const results = [];
  for (const rel of filesToCheck) {
    const full = path.join(rootDir, rel);
    if (!fs.existsSync(full)) continue;
    const content = fs.readFileSync(full, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (line.includes("agentId === 'chatgpt") || line.includes("toAgent.includes('chatgpt") || line.includes("toAgent.includes('claude")) {
        results.push({ file: rel, line: idx + 1, snippet: line.trim() });
      }
    });
  }
  return results;
}
