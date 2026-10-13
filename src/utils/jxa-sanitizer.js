/**
 * JXA / AppleScript Sanitizer and Structural Security Hardening (AR-11)
 *
 * Prevents command/script injection when building JavaScript for Automation (JXA)
 * and AppleScript scripts executed via osascript.
 */

const KNOWN_ALLOWED_APPS = new Set([
  'chatgpt',
  'claude',
  'gemini',
  'google chrome',
  'chrome',
  'safari',
  'slack',
  'terminal',
  'iterm2',
  'system events',
  'finder',
  'textedit',
  'notes'
]);

// Strict identifier pattern: alphanumeric, spaces, dots, underscores, dashes, length 1-64
const SAFE_APP_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

// Characters strictly forbidden in targetApp strings
const FORBIDDEN_CHARS_REGEX = /["'`\\$;(){}[\]<>|&\r\n\0\u2028\u2029]/;

/**
 * Validates that targetApp is safe to interpolate into or pass to automation scripts.
 * Throws a TypeError if the app name contains unsafe characters or fails validation.
 *
 * @param {string} targetApp
 * @returns {string} The validated targetApp
 */
export function validateTargetApp(targetApp) {
  if (typeof targetApp !== 'string' || !targetApp.trim()) {
    throw new TypeError('INVALID_TARGET_APP: Target application name must be a non-empty string');
  }

  const trimmed = targetApp.trim();

  if (FORBIDDEN_CHARS_REGEX.test(trimmed)) {
    throw new TypeError(`INVALID_TARGET_APP: Target application name contains unsafe characters: ${JSON.stringify(trimmed)}`);
  }

  if (trimmed.includes('$(') || trimmed.includes('${') || trimmed.includes('`')) {
    throw new TypeError(`INVALID_TARGET_APP: Target application name contains command substitution syntax: ${JSON.stringify(trimmed)}`);
  }

  const lower = trimmed.toLowerCase();
  const isKnown = KNOWN_ALLOWED_APPS.has(lower);
  const isSafePattern = SAFE_APP_NAME_REGEX.test(trimmed);

  if (!isKnown && !isSafePattern) {
    throw new TypeError(`INVALID_TARGET_APP: Target application name does not match allowlist pattern: ${JSON.stringify(trimmed)}`);
  }

  return trimmed;
}

/**
 * Checks whether an app name is valid and safe without throwing.
 *
 * @param {string} targetApp
 * @returns {boolean}
 */
export function isAllowedTargetApp(targetApp) {
  try {
    validateTargetApp(targetApp);
    return true;
  } catch {
    return false;
  }
}

/**
 * Escapes a dynamic value safely for embedding into JXA code.
 * Ensures quotes, backslashes, newlines, and Unicode line/paragraph separators (U+2028, U+2029)
 * cannot break out of string literals or alter script AST structure.
 *
 * @param {any} val
 * @returns {string}
 */
export function escapeJxaString(val) {
  return JSON.stringify(val === undefined || val === null ? '' : String(val))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
