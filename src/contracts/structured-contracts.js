/**
 * Structured Result Contracts (Mission H.1)
 *
 * Defines lightweight, strict schemas and validators for discrete task types:
 * - review: code/architecture review verdict and structured findings
 * - research: factual query with key findings and sources
 * - patch: unified diff patch and file list
 * - test_run: test execution counts and failure list
 * - decision: architectural decision with rationale and chosen alternative
 *
 * Benefits:
 * - Responders reply in exact compact shape, eliminating conversational prose bloat.
 * - Saves high-cost output tokens.
 * - Machine-verifiable by the bridge before delivery.
 */

export const ContractType = Object.freeze({
  REVIEW: 'review',
  RESEARCH: 'research',
  PATCH: 'patch',
  TEST_RUN: 'test_run',
  DECISION: 'decision'
});

export class StructuredContractValidator {
  /**
   * Validate a payload against a specified contract type.
   * @param {string} contractType
   * @param {object|string} payload
   * @returns {{ valid: boolean, errors?: string[], data?: object, compactText?: string }}
   */
  static validate(contractType, payload) {
    let data = payload;
    if (typeof payload === 'string') {
      try {
        data = JSON.parse(payload);
      } catch {
        // Attempt to extract JSON from markdown code block if present
        const jsonMatch = payload.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          try {
            data = JSON.parse(jsonMatch[1]);
          } catch {}
        }
      }
    }

    if (!data || typeof data !== 'object') {
      return {
        valid: false,
        errors: [`Payload must be a valid JSON object or JSON string matching contract '${contractType}'`]
      };
    }

    switch (contractType) {
      case ContractType.REVIEW:
        return this._validateReview(data);
      case ContractType.RESEARCH:
        return this._validateResearch(data);
      case ContractType.PATCH:
        return this._validatePatch(data);
      case ContractType.TEST_RUN:
        return this._validateTestRun(data);
      case ContractType.DECISION:
        return this._validateDecision(data);
      default:
        return {
          valid: false,
          errors: [`Unknown contract type '${contractType}'`]
        };
    }
  }

  static _validateReview(data) {
    const errors = [];
    const validVerdicts = ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'];
    if (!validVerdicts.includes(data.verdict)) {
      errors.push(`verdict must be one of: ${validVerdicts.join(', ')}`);
    }
    if (!Array.isArray(data.issues)) {
      errors.push('issues must be an array');
    } else {
      data.issues.forEach((issue, idx) => {
        if (!issue.message) errors.push(`issue[${idx}] missing message`);
      });
    }
    if (errors.length > 0) return { valid: false, errors };

    const compactText = `[CONTRACT:REVIEW verdict=${data.verdict} issues=${data.issues.length}]\n` +
      data.issues.map(i => `- [${i.severity || 'WARN'}] ${i.file || ''}:${i.line || ''} ${i.message}`).join('\n') +
      (data.suggestions?.length ? `\nSuggestions:\n` + data.suggestions.map(s => `- ${s}`).join('\n') : '');

    return { valid: true, data, compactText };
  }

  static _validateResearch(data) {
    const errors = [];
    if (!data.answer || typeof data.answer !== 'string') errors.push('answer must be a non-empty string');
    if (!Array.isArray(data.keyFindings) || data.keyFindings.length === 0) errors.push('keyFindings must be a non-empty array of strings');
    if (errors.length > 0) return { valid: false, errors };

    const compactText = `[CONTRACT:RESEARCH confidence=${data.confidence ?? 1.0}]\nAnswer: ${data.answer.trim()}\n` +
      `Key Findings:\n` + data.keyFindings.map(f => `* ${f}`).join('\n') +
      (data.sources?.length ? `\nSources: ${data.sources.join(', ')}` : '');

    return { valid: true, data, compactText };
  }

  static _validatePatch(data) {
    const errors = [];
    if (!data.patch || typeof data.patch !== 'string' || !data.patch.includes('@@')) {
      errors.push('patch must be a valid unified diff string containing @@ hunk markers');
    }
    if (!Array.isArray(data.filesChanged) || data.filesChanged.length === 0) {
      errors.push('filesChanged must be a non-empty array of file paths');
    }
    if (errors.length > 0) return { valid: false, errors };

    const compactText = `[CONTRACT:PATCH files=${data.filesChanged.join(',')} testsNeeded=${Boolean(data.testsNeeded)}]\n${data.patch.trim()}`;
    return { valid: true, data, compactText };
  }

  static _validateTestRun(data) {
    const errors = [];
    const validStatuses = ['PASSED', 'FAILED', 'ERROR'];
    if (!validStatuses.includes(data.status)) errors.push(`status must be one of: ${validStatuses.join(', ')}`);
    if (typeof data.total !== 'number' || typeof data.passed !== 'number') errors.push('total and passed must be numbers');
    if (errors.length > 0) return { valid: false, errors };

    const compactText = `[CONTRACT:TEST_RUN status=${data.status} total=${data.total} passed=${data.passed} failed=${data.failed || 0}]` +
      (data.failures?.length ? '\nFailures:\n' + data.failures.map(f => `! ${f.test}: ${f.error}`).join('\n') : '');

    return { valid: true, data, compactText };
  }

  static _validateDecision(data) {
    const errors = [];
    if (!data.decision || typeof data.decision !== 'string') errors.push('decision must be a string');
    if (!data.rationale || typeof data.rationale !== 'string') errors.push('rationale must be a string');
    if (errors.length > 0) return { valid: false, errors };

    const compactText = `[CONTRACT:DECISION]\nDecision: ${data.decision.trim()}\nRationale: ${data.rationale.trim()}` +
      (data.alternativesConsidered?.length ? `\nAlternatives Considered: ${data.alternativesConsidered.join('; ')}` : '');

    return { valid: true, data, compactText };
  }
}
