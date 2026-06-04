import { describe, it, expect, vi } from 'vitest';

// diffPreview.ts imports 'vscode' for the native diff editor, but
// synthesizeEditedContent is pure — a minimal stub lets the module load in node.
vi.mock('vscode', () => ({
  EventEmitter: class { event = () => undefined; fire() {} dispose() {} },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
}));

import { synthesizeEditedContent } from './diffPreview';

describe('synthesizeEditedContent', () => {
  it('returns null when the target text is absent (caller falls back)', () => {
    expect(synthesizeEditedContent('hello world', 'xyz', 'abc')).toBeNull();
  });

  it('replaces the single occurrence of the target', () => {
    expect(synthesizeEditedContent('a OLD b', 'OLD', 'NEW')).toBe('a NEW b');
  });

  it('replaces only the first occurrence', () => {
    expect(synthesizeEditedContent('x x', 'x', 'y')).toBe('y x');
  });

  it('preserves surrounding content exactly', () => {
    expect(synthesizeEditedContent('l1\nconst x = OLD;\nl3', 'OLD', '42'))
      .toBe('l1\nconst x = 42;\nl3');
  });

  // Regression: String.replace(str, str) interprets $&, $1, $$ in the
  // replacement. Code edits routinely contain `$` (shell vars, template
  // literals, regex), so the new text must be inserted literally.
  it('treats the replacement literally — $ sequences are not special', () => {
    expect(synthesizeEditedContent('price: HERE', 'HERE', '$&100')).toBe('price: $&100');
    expect(synthesizeEditedContent('t = TPL', 'TPL', '`${x}`')).toBe('t = `${x}`');
    expect(synthesizeEditedContent('a = OLD', 'OLD', '$$ and $1')).toBe('a = $$ and $1');
  });
});
