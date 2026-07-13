import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown';
import { _escapeHtmlForTest as escapeHtml, _inlineForTest as inline } from './markdown';

// renderMarkdown turns assistant/user markdown into the HTML injected into the
// chat webview. It's hand-rolled and security-sensitive (HTML escaping + a link
// scheme allowlist), so the escaping and XSS guards get the most attention.

describe('renderMarkdown — escaping', () => {
  it('escapes HTML special characters in plain text', () => {
    expect(renderMarkdown('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d<br>');
  });

  it('never emits a raw <script> tag from prose', () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });
});

describe('renderMarkdown — inline', () => {
  it('renders bold, italic and inline code', () => {
    const out = renderMarkdown('**b** *i* `c`');
    expect(out).toContain('<strong>b</strong>');
    expect(out).toContain('<em>i</em>');
    expect(out).toContain('<code>c</code>');
  });
});

describe('renderMarkdown — link allowlist (XSS guard)', () => {
  it('renders safe http(s) links with noopener', () => {
    const out = renderMarkdown('[click](https://example.com)');
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">click</a>');
  });

  it('allows mailto: and vscode: schemes', () => {
    expect(renderMarkdown('[mail](mailto:a@b.com)')).toContain('href="mailto:a@b.com"');
    expect(renderMarkdown('[cmd](vscode:foo)')).toContain('href="vscode:foo"');
  });

  it('strips a javascript: link down to its label — no anchor, no scheme', () => {
    const out = renderMarkdown('[x](javascript:alert(1))');
    expect(out).not.toContain('href');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('x');
  });

  it('strips a data: URI link the same way', () => {
    const out = renderMarkdown('[y](data:text/html,<script>)');
    expect(out).not.toContain('href');
    expect(out).not.toContain('data:text/html');
  });

  it('escapes a double-quote in a URL so it cannot break out of the href attribute', () => {
    const out = renderMarkdown('[x](https://a"onmouseover=alert(1))');
    expect(out).not.toContain('"onmouseover'); // no raw-quote attribute breakout
    expect(out).toContain('&quot;'); // the quote is entity-encoded instead
  });
});

describe('renderMarkdown — fenced code blocks', () => {
  it('renders a fence as a code-block with its language label and a copy button', () => {
    const out = renderMarkdown('```js\nconst x = 1\n```');
    expect(out).toContain('class="code-block"');
    expect(out).toContain('>js<');
    expect(out).toContain('data-action="copy"');
    expect(out).toContain('<pre><code>const x = 1</code></pre>');
  });

  it('treats fence contents literally — markdown inside is not processed', () => {
    const out = renderMarkdown('```\n**not bold**\n```');
    expect(out).toContain('**not bold**');
    expect(out).not.toContain('<strong>');
  });

  it('escapes HTML inside a fence', () => {
    const out = renderMarkdown('```\n<script>alert(1)</script>\n```');
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script>');
  });
});

describe('renderMarkdown — block elements', () => {
  it('renders headings h1–h3', () => {
    expect(renderMarkdown('# A')).toContain('<h1>A</h1>');
    expect(renderMarkdown('## B')).toContain('<h2>B</h2>');
    expect(renderMarkdown('### C')).toContain('<h3>C</h3>');
  });

  it('renders an unordered list', () => {
    const out = renderMarkdown('- a\n- b');
    expect(out).toContain('<ul><li>a</li><li>b</li></ul>');
  });

  it('renders an ordered list', () => {
    const out = renderMarkdown('1. a\n2. b');
    expect(out).toContain('<ol><li>a</li><li>b</li></ol>');
  });

  it('renders a blockquote', () => {
    expect(renderMarkdown('> hi')).toContain('<blockquote>hi<br></blockquote>');
  });

  it('renders a horizontal rule', () => {
    expect(renderMarkdown('---')).toContain('<hr>');
  });

  it('renders a GitHub-style table with alignment', () => {
    const out = renderMarkdown('| a | b |\n|:---|---:|\n| 1 | 2 |');
    expect(out).toContain('<table>');
    expect(out).toContain('<th style="text-align:left">a</th>');
    expect(out).toContain('<th style="text-align:right">b</th>');
    expect(out).toContain('<td style="text-align:left">1</td>');
  });
});

describe('escapeHtml — internal helper', () => {
  it('escapes &, <, >, ", \' in that order', () => {
    expect(escapeHtml('<a href="x" data-y=\'z\'>b & c</a>'))
      .toBe('&lt;a href=&quot;x&quot; data-y=&#39;z&#39;&gt;b &amp; c&lt;/a&gt;');
  });

  it('escapes every ampersand, including runs', () => {
    expect(escapeHtml('a && b')).toBe('a &amp;&amp; b');
  });

  it('preserves other characters verbatim', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123');
  });

  it('returns empty for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('escapes a lone double-quote (regression for href breakout)', () => {
    expect(escapeHtml('"')).toBe('&quot;');
  });
});

describe('inline — internal helper', () => {
  it('wraps backtick spans in <code>', () => {
    expect(inline('use `foo` here')).toBe('use <code>foo</code> here');
  });

  it('wraps **double-asterisk** in <strong>', () => {
    expect(inline('**bold**')).toBe('<strong>bold</strong>');
  });

  it('wraps *single-asterisk* in <em>', () => {
    expect(inline('*italic*')).toBe('<em>italic</em>');
  });

  it('renders a safe http link as an anchor with noopener', () => {
    expect(inline('[x](https://a.b)')).toBe('<a href="https://a.b" target="_blank" rel="noopener noreferrer">x</a>');
  });

  it('allows mailto: and vscode: schemes', () => {
    expect(inline('[m](mailto:a@b.c)')).toContain('href="mailto:a@b.c"');
    expect(inline('[c](vscode:foo)')).toContain('href="vscode:foo"');
  });

  it('strips javascript: scheme — no anchor, label only', () => {
    const out = inline('[click](javascript:evil)');
    expect(out).not.toContain('href');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('click');
  });

  it('strips data: scheme', () => {
    expect(inline('[y](data:text/html,<b>)')).toBe('y');
  });

  it('returns plain text unchanged when no markdown is present', () => {
    expect(inline('just words')).toBe('just words');
  });

  it('applies all inline styles in one pass', () => {
    const out = inline('**a** *b* `c` [d](https://e.f)');
    expect(out).toContain('<strong>a</strong>');
    expect(out).toContain('<em>b</em>');
    expect(out).toContain('<code>c</code>');
    expect(out).toContain('href="https://e.f"');
  });
});
