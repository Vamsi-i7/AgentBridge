import crypto from 'node:crypto';

const SECRET_PATTERNS = [
  /ab_tok_[a-f0-9]{24,64}/gi,
  /sk-[a-zA-Z0-9]{20,64}/g,
  /bearer\s+[a-zA-Z0-9_\-\.]{20,}/gi,
  /ghp_[a-zA-Z0-9]{36}/g,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[a-zA-Z0-9\/\+=\r\n]+-----END [A-Z ]+ PRIVATE KEY-----/g
];

/**
 * Redaction utility ensuring no secrets, credentials, or full raw prompts
 * leak into dashboard APIs, event streams, or replay views.
 */
export class DashboardRedactor {
  /**
   * Redact sensitive secrets from any string.
   */
  static redactSecrets(text) {
    if (typeof text !== 'string') return text;
    let redacted = text;
    for (const pattern of SECRET_PATTERNS) {
      redacted = redacted.replace(pattern, '[REDACTED_SECRET]');
    }
    return redacted;
  }

  /**
   * Redact prompt text for dashboards and replays.
   * By default, replaces raw prompts with a compact structural descriptor.
   */
  static redactPrompt(promptText) {
    if (!promptText || typeof promptText !== 'string') return '';
    const clean = this.redactSecrets(promptText);
    const hash = crypto.createHash('sha256').update(clean).digest('hex').slice(0, 12);
    const snippet = clean.slice(0, 40).replace(/[\r\n]+/g, ' ');
    return `[REDACTED_PROMPT len=${clean.length} hash=${hash} snippet="${snippet}..."]`;
  }

  /**
   * Recursively redact an object or array before returning to the dashboard.
   */
  static redactObject(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') return this.redactSecrets(obj);
    if (typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
      return obj.map(item => this.redactObject(item));
    }

    const output = {};
    for (const [key, val] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes('token') || lowerKey.includes('secret') || lowerKey.includes('password') || lowerKey.includes('key')) {
        output[key] = '[REDACTED_CREDENTIAL]';
      } else if (lowerKey.includes('prompt') || lowerKey.includes('body') || lowerKey.includes('rawcontent')) {
        output[key] = typeof val === 'string' ? this.redactPrompt(val) : '[REDACTED_CONTENT]';
      } else if (typeof val === 'object') {
        output[key] = this.redactObject(val);
      } else if (typeof val === 'string') {
        output[key] = this.redactSecrets(val);
      } else {
        output[key] = val;
      }
    }
    return output;
  }
}
