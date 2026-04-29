// Markdown renderer — extracts code blocks first, then processes inline/block
// markdown on remaining text, then restores blocks. Hand-rolled instead of a
// dep so we don't ship marked/markdown-it (~15 KB) for our limited needs.

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Markdown links — strip anything that isn't a safe http/https/mailto/vscode
    // scheme. Text has been HTML-escaped earlier so raw < and > can't appear
    // inside the URL — we just need to block javascript: and data: URIs.
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => {
      if (!/^(https?:|mailto:|vscode:)/i.test(url)) return label;
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
}

export function renderMarkdown(text: string): string {
  const blocks: string[] = [];

  // 1. Extract fenced code blocks into placeholders
  let s = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang: string, code: string) => {
    const escaped = escapeHtml(code.trimEnd());
    const label = lang || 'code';
    const block = `<div class="code-block"><div class="code-header">${label}<button class="copy-btn" data-action="copy">Copy</button></div><pre><code>${escaped}</code></pre></div>`;
    blocks.push(block);
    return `\x00BLOCK${blocks.length - 1}\x00`;
  });

  s = escapeHtml(s);

  const lines = s.split('\n');
  const out: string[] = [];
  let inUl = false;
  let inOl = false;
  let inBq = false;

  // Table separator: `|---|---|` etc. with optional alignment colons.
  const tableSep = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
  const splitRow = (line: string): string[] => {
    const trimmed = line.trim().replace(/^\||\|$/g, '');
    return trimmed.split('|').map((c) => c.trim());
  };

  const closeLists = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };
  const closeBlocks = () => {
    closeLists();
    if (inBq) { out.push('</blockquote>'); inBq = false; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Table — current line starts with `|` and the next line is a separator
    if (line.startsWith('|') && i + 1 < lines.length && tableSep.test(lines[i + 1])) {
      closeBlocks();
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const left = c.startsWith(':');
        const right = c.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        return 'left';
      });
      let tbl = '<table><thead><tr>';
      header.forEach((h, idx) => {
        tbl += `<th style="text-align:${aligns[idx] ?? 'left'}">${inline(h)}</th>`;
      });
      tbl += '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const cells = splitRow(lines[i]);
        tbl += '<tr>';
        cells.forEach((c, idx) => {
          tbl += `<td style="text-align:${aligns[idx] ?? 'left'}">${inline(c)}</td>`;
        });
        tbl += '</tr>';
        i++;
      }
      tbl += '</tbody></table>';
      out.push(tbl);
      i--;
      continue;
    }

    if (/^>\s?/.test(line)) {
      if (!inBq) { closeLists(); out.push('<blockquote>'); inBq = true; }
      out.push(inline(line.replace(/^>\s?/, '')) + '<br>');
      continue;
    }
    if (inBq) { out.push('</blockquote>'); inBq = false; }

    if (/^### /.test(line))      { closeLists(); out.push(`<h3>${inline(line.slice(4))}</h3>`); continue; }
    if (/^## /.test(line))       { closeLists(); out.push(`<h2>${inline(line.slice(3))}</h2>`); continue; }
    if (/^# /.test(line))        { closeLists(); out.push(`<h1>${inline(line.slice(2))}</h1>`); continue; }

    if (/^---+$/.test(line.trim())) { closeLists(); out.push('<hr>'); continue; }

    const ulMatch = line.match(/^( {0,4})[-*] (.+)/);
    if (ulMatch) {
      if (!inUl) { if (inOl) { out.push('</ol>'); inOl = false; } out.push('<ul>'); inUl = true; }
      out.push(`<li>${inline(ulMatch[2])}</li>`);
      continue;
    }

    const olMatch = line.match(/^( {0,4})\d+\. (.+)/);
    if (olMatch) {
      if (!inOl) { if (inUl) { out.push('</ul>'); inUl = false; } out.push('<ol>'); inOl = true; }
      out.push(`<li>${inline(olMatch[2])}</li>`);
      continue;
    }

    closeLists();

    if (line.trim() === '') { out.push('<br>'); continue; }

    out.push(inline(line) + '<br>');
  }

  closeBlocks();

  s = out.join('');
  s = s.replace(/\x00BLOCK(\d+)\x00/g, (_, i: string) => blocks[+i]);
  return s;
}

export function copyCodeBlock(btn: HTMLElement): void {
  const block = btn.closest('.code-block');
  const code = block?.querySelector('code')?.textContent ?? '';
  navigator.clipboard.writeText(code).then(
    () => {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    },
    () => {
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    },
  );
}
