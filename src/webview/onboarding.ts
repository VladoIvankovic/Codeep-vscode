import { messagesEl, scrollToBottom } from './dom';
import { copyCodeBlock } from './markdown';

export function appendOnboarding(): void {
  const div = document.createElement('div');
  div.className = 'onboarding';

  const p1 = document.createElement('p');
  p1.textContent = 'Codeep CLI is not installed or not found.';
  const p2 = document.createElement('p');
  p2.textContent = 'Install it with:';

  const block = document.createElement('div');
  block.className = 'code-block';

  const header = document.createElement('div');
  header.className = 'code-header';
  header.textContent = 'terminal';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => copyCodeBlock(copyBtn));
  header.appendChild(copyBtn);

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = 'npm install -g codeep';
  pre.appendChild(code);
  block.appendChild(header);
  block.appendChild(pre);

  const p3 = document.createElement('p');
  p3.textContent = 'Then reload this window.';

  div.appendChild(p1);
  div.appendChild(p2);
  div.appendChild(block);
  div.appendChild(p3);
  messagesEl.appendChild(div);
  scrollToBottom();
}
