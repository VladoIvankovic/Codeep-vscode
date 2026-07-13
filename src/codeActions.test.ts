import { describe, it, expect, vi } from 'vitest';

// codeActions.ts imports 'vscode' for the CodeActionKind / CodeAction
// classes, but `fence` and `buildPrompt` are pure string builders.
vi.mock('vscode', () => ({
  CodeActionKind: {
    QuickFix: { value: 'quickfix' },
    RefactorRewrite: { value: 'refactor.rewrite' },
    Empty: { value: '' },
  },
  CodeAction: class {},
  commands: { registerCommand: () => ({ dispose() {} }) },
  languages: { registerCodeActionsProvider: () => ({ dispose() {} }) },
  window: {},
  workspace: {},
}));

import { _fenceForTest as fence, _buildPromptForTest as buildPrompt } from './codeActions';

describe('fence', () => {
  it('wraps code in a fenced block with a file header comment', () => {
    const out = fence('ts', 'src/foo.ts', 'const x = 1');
    expect(out).toBe('```ts\n// src/foo.ts\nconst x = 1\n```');
  });

  it('preserves multi-line code verbatim', () => {
    const code = 'const a = 1;\nconst b = 2;';
    expect(fence('js', 'm.js', code)).toBe('```js\n// m.js\n' + code + '\n```');
  });

  it('handles empty code', () => {
    expect(fence('py', 'e.py', '')).toBe('```py\n// e.py\n\n```');
  });

  it('passes through an empty language tag', () => {
    expect(fence('', 'f', 'x')).toBe('```\n// f\nx\n```');
  });
});

describe('buildPrompt', () => {
  const code = 'function add(a, b) { return a + b; }';
  const file = 'src/add.ts';
  const lang = 'ts';

  it('explain — wraps the block with an explain ask', () => {
    const out = buildPrompt('explain', file, lang, code);
    expect(out).toContain('Explain what this code does');
    expect(out).toContain('```ts\n// src/add.ts\n' + code + '\n```');
  });

  it('improve — asks for a refactor with reasoning', () => {
    const out = buildPrompt('improve', file, lang, code);
    expect(out).toContain('improve it');
    expect(out).toContain('refactored version');
    expect(out).toContain(code);
  });

  it('tests — asks for unit tests using the project framework', () => {
    const out = buildPrompt('tests', file, lang, code);
    expect(out).toContain('unit tests');
    expect(out).toContain('test framework already present');
  });

  it('docs — asks for doc comments without changing behaviour', () => {
    const out = buildPrompt('docs', file, lang, code);
    expect(out).toContain('doc comments');
    expect(out).toContain('without changing its behavior');
  });

  it('fix — lists diagnostics when present', () => {
    const out = buildPrompt('fix', file, lang, code, ['Type error: number is not assignable to string']);
    expect(out).toContain('Problems reported here:');
    expect(out).toContain('- Type error: number is not assignable to string');
    expect(out).toContain('Fix the problem');
  });

  it('fix — omits the diagnostics section when none are provided', () => {
    const out = buildPrompt('fix', file, lang, code);
    expect(out).not.toContain('Problems reported here');
    expect(out).toContain('Fix the problem(s)');
  });

  it('fix — omits the diagnostics section when the array is empty', () => {
    const out = buildPrompt('fix', file, lang, code, []);
    expect(out).not.toContain('Problems reported here');
  });

  it('always embeds the fenced code block', () => {
    for (const kind of ['explain', 'improve', 'tests', 'docs', 'fix'] as const) {
      const out = buildPrompt(kind, file, lang, code);
      expect(out).toContain('```ts');
      expect(out).toContain(code);
    }
  });
});
