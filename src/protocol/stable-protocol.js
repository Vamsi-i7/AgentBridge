/**
 * Minimal Stable Protocol Text (Mission B)
 *
 * Requirements:
 * 1. Byte-identical custom-instruction block per agent for 100% prompt caching hits.
 * 2. Dynamic/variable content (request ID, task context, user prompt) placed strictly LAST.
 * 3. Answer only: dense, no preamble, no restating query, no conversational filler, no sign-off.
 * 4. Two-phase return: authenticated bridge_submit_task_result delivers the answer,
 *    and model replies in chat with ONLY "✓" (single checkmark), so output is never doubled.
 */

export const STABLE_PROTOCOL_INSTRUCTIONS = Object.freeze(
`[AgentBridge Protocol v2]
Rules:
1. Answer only. Dense, high-signal technical content.
2. No preamble, no repeating or restating the prompt, no conversational filler, no sign-offs.
3. If tool bridge_submit_task_result is available:
   - Call bridge_submit_task_result({ taskId, status: 'completed', result: <your_answer> }).
   - In your chat turn, reply with ONLY the single character: ✓
4. If bridge_submit_task_result is unavailable:
   - Output your authentic answer directly with no pleasantries.`
);

/**
 * Build prompt adhering to byte-identical caching rules with dynamic content last.
 *
 * @param {object} params
 * @param {string} params.message - The task or question body.
 * @param {string} [params.requestId]
 * @param {string} [params.taskId]
 * @param {string} [params.fromAgent]
 * @param {string} [params.toAgent]
 * @param {string} [params.reasoningEffort] - 'light' | 'medium' | 'deep'
 * @param {string} [params.contentRef] - Content-addressed reference if passed by ref
 * @returns {string}
 */
export function formatStableProtocolPrompt({
  message,
  requestId = null,
  taskId = null,
  fromAgent = null,
  toAgent = null,
  reasoningEffort = null,
  contentRef = null
}) {
  const parts = [STABLE_PROTOCOL_INSTRUCTIONS];

  const metaLines = [];
  if (requestId) metaLines.push(`request_id: ${requestId}`);
  if (taskId) metaLines.push(`task_id: ${taskId}`);
  if (fromAgent) metaLines.push(`from: ${fromAgent}`);
  if (toAgent) metaLines.push(`to: ${toAgent}`);
  if (reasoningEffort) metaLines.push(`reasoning_effort: ${reasoningEffort}`);
  if (contentRef) metaLines.push(`content_ref: ${contentRef}`);

  if (metaLines.length > 0) {
    parts.push(`[Context]\n${metaLines.join('\n')}`);
  }

  // Dynamic variable content strictly last
  parts.push(`[Task]\n${message || ''}`);

  return parts.join('\n\n');
}

/**
 * Check if a model's chat output is the checkmark acknowledgment
 * indicating that full content was submitted via tool.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isCheckmarkAcknowledgment(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  return trimmed === '✓' || trimmed === '[✓]' || trimmed === '✔';
}
