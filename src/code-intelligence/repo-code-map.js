import fs from 'node:fs';
import path from 'node:path';

/**
 * Repo Symbol Outline Generator (formerly RepoCodeMapGenerator)
 *
 * TRUTHFUL CLASSIFICATION & KNOWN LIMITATIONS:
 * - This is a HEURISTIC REGEX-BASED SYMBOL OUTLINE GENERATOR, NOT a full AST parser.
 * - It does not build a full concrete syntax tree or evaluate macro expansions.
 * - Complex nested templates spanning hundreds of lines or code inside multiline string literals
 *   may produce false positives or approximate boundaries.
 * - For production symbol-accurate AST parsing, an external language server or Tree-sitter adapter
 *   should be used when full semantic fidelity is required.
 *
 * PURPOSE:
 * Generates compact, token-efficient symbol outlines (classes, methods, functions, signatures)
 * instead of passing whole multi-KB source files across model turns, saving 80-90% upfront tokens.
 */
export class RepoSymbolOutlineGenerator {
  constructor(options = {}) {
    this.allowedRoots = options.allowedRoots || [process.cwd()];
  }

  /**
   * Parse a source file into a compact symbol outline.
   * @param {string} filePath
   * @param {string} [content=null]
   * @returns {{ file: string, filePath: string, lineCount: number, symbols: Array<{ type: string, name: string, signature: string, line: number, decorators?: string[] }> }}
   */
  parseSymbols(filePath, content = null) {
    const raw = content !== null ? content : fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n');
    const symbols = [];

    // Regex patterns for JS/TS/Python
    // 1. Class: export? class Name<Generics>? (extends Name<Generics>?)?
    const classRe = /^\s*(?:export\s+(?:default\s+)?)?class\s+([A-Za-z0-9_$]+)(?:<[^>]+>)?(?:\s+extends\s+[A-Za-z0-9_$.<>\s]+)?/i;
    // 2. Standard JS/TS Function: export? async? function Name<Generics>?(...)
    const funcRe = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)(?:<[^>]+>)?\s*\(([^)]*)\)/i;
    // 3. Arrow function / Function expression: export? const/let/var Name = async? <Generics>?(...) =>
    const arrowFuncRe = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:<[^>]+>)?\s*(?:\(([^)]*)\)|([A-Za-z0-9_$]+))\s*(?::\s*[^=]+)?\s*=>/;
    // 4. Method inside class: async? methodName<Generics>?(...) {
    const methodRe = /^\s*(?:(?:public|private|protected|static|readonly|async)\s+)*([A-Za-z0-9_$]+)(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\s*\{/;
    // 5. Class field arrow method: fieldName = async? (...) =>
    const classFieldArrowRe = /^\s*(?:(?:public|private|protected|static|readonly)\s+)*([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/;
    // 6. Python def / async def
    const pyDefRe = /^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)(?:\s*->\s*[^:]+)?:/;
    // 7. Python class
    const pyClassRe = /^\s*class\s+([A-Za-z0-9_]+)(?:\([^)]*\))?:/;

    let inBlockComment = false;
    let pendingDecorators = [];

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      const lineNum = i + 1;
      const trimmed = line.trim();

      // Block comment handling
      if (inBlockComment) {
        if (trimmed.includes('*/')) {
          inBlockComment = false;
        }
        continue;
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) {
          inBlockComment = true;
        }
        continue;
      }

      // Single line comments
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
        continue;
      }

      // Decorators (@decorator or @decorator(...))
      if (trimmed.startsWith('@') && !trimmed.startsWith('@param') && !trimmed.startsWith('@return')) {
        pendingDecorators.push(trimmed);
        continue;
      }

      // Check multiline function/method signature continuation if line has '(' without ')'
      if (trimmed.includes('(') && !trimmed.includes(')') && !trimmed.includes('{') && !trimmed.includes(':') && !trimmed.startsWith('if') && !trimmed.startsWith('for') && !trimmed.startsWith('while')) {
        let joined = trimmed;
        let j = i + 1;
        while (j < lines.length && !lines[j].includes(')') && j - i < 8) {
          joined += ' ' + lines[j].trim();
          j++;
        }
        if (j < lines.length && lines[j].includes(')')) {
          joined += ' ' + lines[j].trim();
          if (lines[j].includes('{') || (j + 1 < lines.length && lines[j + 1].trim().startsWith('{'))) {
            joined += ' {';
          }
        }
        line = joined;
      }

      // Class
      let match = line.match(classRe) || line.match(pyClassRe);
      if (match) {
        const entry = {
          type: 'class',
          name: match[1],
          signature: match[0].trim(),
          line: lineNum
        };
        if (pendingDecorators.length > 0) {
          entry.decorators = [...pendingDecorators];
          pendingDecorators = [];
        }
        symbols.push(entry);
        continue;
      }

      // Function
      match = line.match(funcRe) || line.match(arrowFuncRe) || line.match(pyDefRe);
      if (match) {
        const params = (match[2] !== undefined ? match[2] : match[3]) || '';
        const entry = {
          type: 'function',
          name: match[1],
          signature: `${match[1]}(${params.trim()})`,
          line: lineNum
        };
        if (pendingDecorators.length > 0) {
          entry.decorators = [...pendingDecorators];
          pendingDecorators = [];
        }
        symbols.push(entry);
        continue;
      }

      // Method or Class field arrow method
      match = line.match(methodRe) || line.match(classFieldArrowRe);
      if (match && !['if', 'for', 'while', 'switch', 'catch'].includes(match[1])) {
        const entry = {
          type: 'method',
          name: match[1],
          signature: `${match[1]}(${(match[2] || '').trim()})`,
          line: lineNum
        };
        if (pendingDecorators.length > 0) {
          entry.decorators = [...pendingDecorators];
          pendingDecorators = [];
        }
        symbols.push(entry);
        continue;
      }

      // If line is neither decorator nor match, reset pending decorators
      if (!trimmed.startsWith('@')) {
        pendingDecorators = [];
      }
    }

    return {
      file: path.basename(filePath),
      filePath,
      lineCount: lines.length,
      symbols
    };
  }

  /**
   * Format symbol outline into compact plain text.
   */
  formatCompactMap(parsed) {
    const lines = [`[CODE-MAP file=${parsed.file} lines=${parsed.lineCount}]`];
    for (const sym of parsed.symbols) {
      const dec = sym.decorators && sym.decorators.length > 0 ? ` [${sym.decorators.join(' ')}]` : '';
      lines.push(`L${sym.line}: [${sym.type}] ${sym.signature}${dec}`);
    }
    return lines.join('\n');
  }

  /**
   * Fetch specific symbol implementation on-demand.
   */
  fetchSymbolContent(filePath, symbolName, content = null) {
    const raw = content !== null ? content : fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n');
    const parsed = this.parseSymbols(filePath, raw);

    const target = parsed.symbols.find(s => s.name === symbolName);
    if (!target) return null;

    // Extract slice from line to end of block
    const startLine = target.line - 1;
    let endLine = Math.min(lines.length, startLine + 35);

    // Heuristic brace matching
    let openBraces = 0;
    let foundFirstBrace = false;
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];
      for (const ch of line) {
        if (ch === '{') { openBraces++; foundFirstBrace = true; }
        else if (ch === '}') { openBraces--; }
      }
      if (foundFirstBrace && openBraces <= 0) {
        endLine = i + 1;
        break;
      }
    }

    const snippet = lines.slice(startLine, endLine).join('\n');
    return {
      file: path.basename(filePath),
      symbol: target.name,
      type: target.type,
      startLine: target.line,
      endLine,
      code: snippet
    };
  }
}

// Backward-compatible alias
export const RepoCodeMapGenerator = RepoSymbolOutlineGenerator;
