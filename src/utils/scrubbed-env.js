/**
 * Centralized, allowlisted environment scrub for all spawned child processes.
 *
 * Prevents process.env leakage (API keys, bridge tokens, secrets, credentials)
 * to any spawned tool, adapter, CLI or helper process.
 */

export const ALLOWED_ENV_WHITELIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'USER',
  'SHELL',
  'TERM',
  'NODE_PATH'
];

export function getScrubbedEnv(extraEnv = {}) {
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin',
    HOME: process.env.HOME || '/Users/jayanthpranaykonada',
    LANG: process.env.LANG || 'en_US.UTF-8',
    USER: process.env.USER || 'jayanthpranaykonada',
    SHELL: process.env.SHELL || '/bin/zsh',
    TMPDIR: process.env.TMPDIR || '/tmp'
  };

  for (const key of ALLOWED_ENV_WHITELIST) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }

  if (extraEnv && typeof extraEnv === 'object') {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v !== undefined && v !== null) {
        env[k] = String(v);
      }
    }
  }

  return env;
}
