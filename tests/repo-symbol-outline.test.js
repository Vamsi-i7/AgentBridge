import test from 'node:test';
import assert from 'node:assert';
import { RepoSymbolOutlineGenerator, RepoCodeMapGenerator } from '../src/code-intelligence/repo-code-map.js';

test('RepoSymbolOutlineGenerator: Hard Cases & Heuristic Accuracy', async (t) => {
  const generator = new RepoSymbolOutlineGenerator();

  await t.test('1. Ignores comments containing keywords', () => {
    const code = `
// class FakeClass {
// function fakeFunction() {}
/*
 * class AnotherFakeClass
 * function anotherFake()
 */
# def fake_python_function():
export class RealClass {
  // methodInsideComment()
  realMethod() {
    return 1;
  }
}
`;
    const res = generator.parseSymbols('test.js', code);
    assert.strictEqual(res.symbols.length, 2);
    assert.strictEqual(res.symbols[0].name, 'RealClass');
    assert.strictEqual(res.symbols[0].type, 'class');
    assert.strictEqual(res.symbols[1].name, 'realMethod');
    assert.strictEqual(res.symbols[1].type, 'method');
  });

  await t.test('2. Handles TypeScript generics and class field arrow functions', () => {
    const tsCode = `
export class Container<T extends Record<string, any>> {
  public transform<R>(input: T): R {
    return null;
  }
  handleEvent = async (event: any) => {
    console.log(event);
  };
}
`;
    const res = generator.parseSymbols('test.ts', tsCode);
    assert.strictEqual(res.symbols.length, 3);
    assert.strictEqual(res.symbols[0].name, 'Container');
    assert.strictEqual(res.symbols[1].name, 'transform');
    assert.strictEqual(res.symbols[2].name, 'handleEvent');
  });

  await t.test('3. Handles multiline function signatures and decorators', () => {
    const decCode = `
@Injectable()
@Logged
export class UserService {
  @Get('/users')
  async findUsers(
    query: string,
    limit: number
  ) {
    return [];
  }
}
`;
    const res = generator.parseSymbols('service.ts', decCode);
    assert.strictEqual(res.symbols.length, 2);
    assert.strictEqual(res.symbols[0].name, 'UserService');
    assert.ok(res.symbols[0].decorators.includes('@Logged'));
    assert.strictEqual(res.symbols[1].name, 'findUsers');
  });

  await t.test('4. Handles Python defs, async defs, and classes', () => {
    const pyCode = `
class NeuralNetwork(torch.nn.Module):
    def __init__(self, layers: int):
        super().__init__()

    async def forward(self, x: Tensor) -> Tensor:
        return x
`;
    const res = generator.parseSymbols('model.py', pyCode);
    assert.strictEqual(res.symbols.length, 3);
    assert.strictEqual(res.symbols[0].name, 'NeuralNetwork');
    assert.strictEqual(res.symbols[0].type, 'class');
    assert.strictEqual(res.symbols[1].name, '__init__');
    assert.strictEqual(res.symbols[2].name, 'forward');
  });

  await t.test('5. Backward compatibility alias RepoCodeMapGenerator exists', () => {
    assert.strictEqual(RepoCodeMapGenerator, RepoSymbolOutlineGenerator);
    const legacy = new RepoCodeMapGenerator();
    const res = legacy.parseSymbols('foo.js', 'function hello() {}');
    assert.strictEqual(res.symbols[0].name, 'hello');
  });
});
