import { describe, it, expect, beforeEach, vi } from 'vitest';

// The workbench renderers write straight into the DOM, and the unit suite runs
// in node. `./dom` is mocked with the handful of element stubs these functions
// touch, plus a minimal `document` for the elements they create themselves.

const dom = vi.hoisted(() => {
  type FakeEl = Record<string, any>;

  function query(root: FakeEl, selector: string): FakeEl[] {
    const wanted = selector.replace(/^\./, '');
    const found: FakeEl[] = [];
    for (const child of root.children) {
      if (String(child.className).split(' ').includes(wanted)) found.push(child);
      found.push(...query(child, selector));
    }
    return found;
  }

  function makeEl(): FakeEl {
    const classes = new Set<string>();
    let html = '';
    let ownText = '';
    const el: FakeEl = {
      children: [] as FakeEl[],
      dataset: {} as Record<string, string>,
      className: '',
      textContent: '',
      classList: {
        add: (...names: string[]) => names.forEach((n) => classes.add(n)),
        remove: (...names: string[]) => names.forEach((n) => classes.delete(n)),
        contains: (name: string) => classes.has(name),
        toggle: (name: string) =>
          classes.has(name) ? (classes.delete(name), false) : (classes.add(name), true),
      },
      appendChild: (child: FakeEl) => { el.children.push(child); return child; },
      append: (...kids: FakeEl[]) => { el.children.push(...kids); },
      setAttribute: () => undefined,
      addEventListener: () => undefined,
      remove: () => undefined,
      querySelector: (selector: string) => query(el, selector)[0] ?? null,
      querySelectorAll: (selector: string) => query(el, selector),
    };
    Object.defineProperty(el, 'innerHTML', {
      get: () => html,
      set: (value: string) => { html = value; el.children.length = 0; },
    });
    // Mirror the DOM: reading textContent concatenates descendants. Without this
    // a tool row's title — which appendToolCall puts in a child .tool-item-label
    // — reads as '', and any assertion about title-based classification passes
    // whether the code under test looks at the title or not.
    Object.defineProperty(el, 'textContent', {
      get: () => (el.children.length ? el.children.map((c: FakeEl) => c.textContent).join('') : ownText),
      set: (value: string) => { ownText = value ?? ''; el.children.length = 0; },
    });
    return el;
  }

  (globalThis as any).document = { createElement: () => makeEl(), getElementById: () => null };
  (globalThis as any).acquireVsCodeApi = () => ({ postMessage: () => undefined });

  return {
    activityCountEl: makeEl(),
    activityListEl: makeEl(),
    agentStatusEl: makeEl(),
    messagesEl: makeEl(),
    planHostEl: makeEl(),
    summaryActionsEl: makeEl(),
    summaryChecksEl: makeEl(),
    summaryNextEl: makeEl(),
    taskOverviewEl: makeEl(),
    taskSubtitleEl: makeEl(),
    taskTitleEl: makeEl(),
    toolActivityEl: makeEl(),
    scrollToBottom: () => undefined,
  };
});

vi.mock('./dom', () => dom);

import {
  _toolIconClassForTest as toolIconClass,
  appendToolCall,
  beginTask,
  completeTask,
  updateToolCall,
} from './messages';
import { state } from './state';

beforeEach(() => {
  state.currentPlanEl = null;
  state.currentToolGroupEl = null;
  state.toolCallItems.clear();
  state.toolCallKinds.clear();
});

describe('completeTask — plan placeholder', () => {
  it('clears the "Building the plan..." spinner when the run emitted no plan', () => {
    beginTask('Fix the login bug');
    expect(dom.planHostEl.innerHTML).toContain('Building the plan');

    completeTask();
    expect(dom.planHostEl.innerHTML).not.toContain('Building the plan');
    expect(dom.planHostEl.innerHTML).not.toContain('codicon-modifier-spin');
    expect(dom.planHostEl.innerHTML).toContain('No plan steps');
  });

  it('leaves no spinner behind on the restored-history path (beginTask then completeTask)', () => {
    beginTask('Restore this transcript');
    completeTask();
    expect(dom.planHostEl.innerHTML).not.toContain('codicon-modifier-spin');
  });
});

describe('toolIconClass', () => {
  it('maps the ACP kind, whatever vocabulary the title uses', () => {
    expect(toolIconClass('edit', 'Edit src/webview/list.ts')).toBe('codicon-edit');
    expect(toolIconClass('write', 'Write README.md')).toBe('codicon-edit');
    expect(toolIconClass('execute', 'npm ci')).toBe('codicon-terminal');
    expect(toolIconClass('fetch', 'https://example.com')).toBe('codicon-globe');
    expect(toolIconClass('think', 'Considering the options')).toBe('codicon-lightbulb');
  });

  it('falls back to the title when the CLI sends no kind', () => {
    expect(toolIconClass(undefined, 'Read package.json')).toBe('codicon-search');
    expect(toolIconClass(undefined, 'Run the linter')).toBe('codicon-terminal');
    expect(toolIconClass(undefined, 'Something unfamiliar')).toBe('codicon-tools');
  });
});

describe('run summary — Checks', () => {
  it('counts executions only, so a failed read of a *.test.ts file is not a check', () => {
    beginTask('Look at the tests');
    appendToolCall('Read src/chatPanel.test.ts', 'call-1', 'read');
    updateToolCall('call-1', 'failed');
    expect(dom.summaryChecksEl.textContent).toBe('Not run');

    appendToolCall('npm test', 'call-2', 'execute');
    updateToolCall('call-2', 'completed');
    expect(dom.summaryChecksEl.textContent).toBe('1 passed');
  });

  it('reports a failed execution as a failed check', () => {
    beginTask('Run the suite');
    appendToolCall('npm test', 'call-1', 'execute');
    updateToolCall('call-1', 'failed');
    expect(dom.summaryChecksEl.textContent).toBe('1 failed');
  });
});
