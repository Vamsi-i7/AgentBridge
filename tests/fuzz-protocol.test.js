import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestEnvelope } from '../src/protocol/envelope.js';
import { StructuredContractValidator, ContractType } from '../src/contracts/structured-contracts.js';
import { A2AAdapter } from '../src/interop/a2a-adapter.js';

// Deterministic PRNG (Linear Congruential Generator)
function createPrng(seed = 123456789) {
  let s = seed;
  return function next() {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const prng = createPrng(42);

function generateFuzzString(length = 20) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{};:\'",.<>/?\\|`~ \t\n\r\0\uFFFF\uD800\uDFFF';
  let str = '';
  for (let i = 0; i < length; i++) {
    const idx = Math.floor(prng() * chars.length);
    str += chars[idx];
  }
  return str;
}

function generateFuzzPayload(depth = 0) {
  if (depth > 4 || prng() < 0.3) {
    const r = prng();
    if (r < 0.2) return null;
    if (r < 0.4) return prng() < 0.5 ? true : false;
    if (r < 0.6) return (prng() - 0.5) * 1e10;
    return generateFuzzString(Math.floor(prng() * 40));
  }

  if (prng() < 0.5) {
    const arr = [];
    const len = Math.floor(prng() * 5);
    for (let i = 0; i < len; i++) {
      arr.push(generateFuzzPayload(depth + 1));
    }
    return arr;
  } else {
    const obj = {};
    const len = Math.floor(prng() * 5);
    for (let i = 0; i < len; i++) {
      const key = generateFuzzString(8);
      obj[key] = generateFuzzPayload(depth + 1);
    }
    return obj;
  }
}

test('Offline Protocol & Envelope Fuzzing Suite [TEST-PROVEN]', async (t) => {

  await t.test('1. Envelope Parser Fuzzing (100 iterations, bounded)', () => {
    let handledCount = 0;
    for (let i = 0; i < 100; i++) {
      const raw = generateFuzzPayload();
      try {
        const parsed = RequestEnvelope.parse(raw);
        // If it parses, ensure no prototype pollution occurred
        assert.strictEqual(Object.prototype.polluted, undefined);
        if (parsed) handledCount++;
      } catch (err) {
        // Safe rejection expected on invalid inputs
        assert.ok(err instanceof Error);
        handledCount++;
      }
    }
    assert.strictEqual(handledCount, 100);
  });

  await t.test('2. Structured Contract Validator Fuzzing (100 iterations)', () => {
    let evaluated = 0;
    const contractTypes = [ContractType.REVIEW, ContractType.RESEARCH, ContractType.PATCH, ContractType.TEST_RUN, ContractType.DECISION];

    for (let i = 0; i < 100; i++) {
      const cType = contractTypes[i % contractTypes.length];
      const payload = generateFuzzPayload();
      const res = StructuredContractValidator.validate(cType, payload);
      assert.strictEqual(typeof res.valid, 'boolean');
      if (!res.valid) {
        assert.ok(Array.isArray(res.errors));
      }
      evaluated++;
    }
    assert.strictEqual(evaluated, 100);
  });

  await t.test('3. A2A JSON-RPC Handler Fuzzing (100 iterations)', async () => {
    const adapter = new A2AAdapter();
    let handled = 0;

    for (let i = 0; i < 100; i++) {
      const fuzzBody = generateFuzzPayload();
      const resp = await adapter.handleA2ARequest(fuzzBody, { agentId: 'gemini' });
      assert.strictEqual(resp.jsonrpc, '2.0');
      // Must either return valid result or structured error object with code
      if (resp.error) {
        assert.strictEqual(typeof resp.error.code, 'number');
        assert.strictEqual(typeof resp.error.message, 'string');
      } else {
        assert.ok(resp.result !== undefined);
      }
      handled++;
    }
    assert.strictEqual(handled, 100);
  });
});
