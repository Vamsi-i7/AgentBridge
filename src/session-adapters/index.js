import { AgentSessionAdapter } from './base-adapter.js';
import { AntigravitySessionAdapter } from './antigravity-adapter.js';
import { ClaudeDesktopSessionAdapter } from './claude-adapter.js';
import { ChatGPTSessionAdapter } from './chatgpt-adapter.js';
import { DesktopUIAdapter, ClaudeDesktopUIAdapter, ChatGPTDesktopUIAdapter } from './desktop-ui-adapter.js';
import { CompositeSessionAdapter } from './composite-adapter.js';
import { sendDesktopNotification, activateDesktopApp } from './desktop-notifier.js';

export {
  AgentSessionAdapter,
  AntigravitySessionAdapter,
  ClaudeDesktopSessionAdapter,
  ChatGPTSessionAdapter,
  DesktopUIAdapter,
  ClaudeDesktopUIAdapter,
  ChatGPTDesktopUIAdapter,
  CompositeSessionAdapter,
  sendDesktopNotification,
  activateDesktopApp
};

const ADAPTER_FACTORIES = new Map([
  ['antigravity', (opts) => new AntigravitySessionAdapter(opts)],
  ['antigravity-ide', (opts) => new AntigravitySessionAdapter(opts)],
  ['claude-desktop', (opts) => new ClaudeDesktopSessionAdapter(opts)],
  ['chatgpt-desktop', (opts) => new ChatGPTSessionAdapter(opts)],
  ['claude-ui', (opts) => new ClaudeDesktopUIAdapter(opts)],
  ['chatgpt-ui', (opts) => new ChatGPTDesktopUIAdapter(opts)]
]);

export function registerSessionAdapterFactory(agentId, factory) {
  ADAPTER_FACTORIES.set(agentId.toLowerCase(), factory);
}

export function createSessionAdapter(agentId, options = {}) {
  if (options.useComposite || options.desktopAutomation !== undefined || options.enableDesktopUI) {
    return new CompositeSessionAdapter(agentId, options);
  }

  const factory = ADAPTER_FACTORIES.get(String(agentId || '').toLowerCase());
  if (factory) {
    return factory(options);
  }
  return new AgentSessionAdapter(agentId, options);
}
