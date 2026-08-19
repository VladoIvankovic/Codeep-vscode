import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  loadPersonalities,
  normalizeRpcPersonality,
  parsePersonalityMarkdown,
  personalitiesForLegacyCore,
  personalityDetail,
} from './personalities';

describe('parsePersonalityMarkdown', () => {
  it('prefers custom-bot/v1 frontmatter over human-readable sections', () => {
    const parsed = parsePersonalityMarkdown('release-guardian', `---
codeep: custom-bot/v1
description: Keeps every release safe and reviewable.
model: anthropic/claude-sonnet-4-5
tools: [files, terminal, tests, git]
scope: selected
projects: [Codeep, docs-site]
---
# Release Guardian
> A deliberately different visible description.

## Model
Automatic

## Tools
- Web

## Scope
All projects
`, 'global');

    expect(parsed).toMatchObject({
      displayName: 'Release Guardian',
      description: 'Keeps every release safe and reviewable.',
      model: 'anthropic/claude-sonnet-4-5',
      tools: ['Files', 'Terminal', 'Tests', 'Git'],
      scope: 'Selected projects',
      projects: ['Codeep', 'docs-site'],
      structured: true,
      restrictTools: true,
    });
  });

  it('falls back to compatible Markdown sections', () => {
    const parsed = parsePersonalityMarkdown('ui-reviewer', `# UI Reviewer
> Reviews responsive and accessible UI.

## Responsibility
Review responsive and accessible UI.

## Model
openai/gpt-5.6-sol

## Tools
- Files
- Web

## Scope
Personal mode only

## Projects
- Codeep
`, 'project');

    expect(parsed.model).toBe('openai/gpt-5.6-sol');
    expect(parsed.tools).toEqual(['Files', 'Web']);
    expect(parsed.scope).toBe('Personal mode only');
    expect(parsed.projects).toEqual(['Codeep']);
    expect(parsed.structured).toBe(true);
  });

  it('marks legacy Markdown as unrestricted instead of inventing constraints', () => {
    const parsed = parsePersonalityMarkdown(
      'pirate',
      '# Pirate\nAlways answer like a pirate. Arrr.\n',
      'global',
    );
    expect(parsed).toMatchObject({
      displayName: 'Pirate',
      description: 'Always answer like a pirate. Arrr.',
      model: 'Automatic',
      tools: [],
      scope: 'All projects',
      structured: false,
      restrictTools: false,
    });
    expect(personalityDetail(parsed)).toContain('Unrestricted');
  });

  it('shows an explicit empty tool list as conversation-only', () => {
    const parsed = parsePersonalityMarkdown(
      'conversation-only',
      '---\ncodeep: custom-bot/v1\ntools: []\n---\n# Conversation Only\n',
      'global',
    );
    expect(parsed.structured).toBe(true);
    expect(parsed.restrictTools).toBe(true);
    expect(parsed.tools).toEqual([]);
    expect(personalityDetail(parsed)).toContain('None');
    expect(personalityDetail(parsed)).not.toContain('Unrestricted');
  });

  it('keeps a natural legacy Tools heading unrestricted', () => {
    const parsed = parsePersonalityMarkdown(
      'writer',
      '# Writer\n\n## Tools\nExplain the tools of the trade.\n',
      'global',
    );
    expect(parsed.structured).toBe(false);
    expect(parsed.restrictTools).toBe(false);
    expect(personalityDetail(parsed)).toContain('Unrestricted');
  });

  it('keeps Model, Tools, and Scope prose legacy without Responsibility', () => {
    const parsed = parsePersonalityMarkdown(
      'writer',
      '# Writer\n\n## Model\nExplain a model.\n\n## Tools\nExplain tools.\n\n## Scope\nExplain scope.\n',
      'global',
    );
    expect(parsed.structured).toBe(false);
    expect(parsed.restrictTools).toBe(false);
    expect(parsed.available).toBe(true);
  });

  it('fails closed when v1 omits or malforms Tools', () => {
    const missing = parsePersonalityMarkdown(
      'missing-tools',
      '---\ncodeep: custom-bot/v1\n---\n# Missing Tools\n',
      'global',
    );
    const malformed = parsePersonalityMarkdown(
      'malformed-tools',
      '---\ncodeep: custom-bot/v1\ntools: files\n---\n# Malformed Tools\n',
      'global',
    );
    expect(missing.restrictTools).toBe(true);
    expect(missing.tools).toEqual([]);
    expect(malformed.restrictTools).toBe(true);
    expect(malformed.tools).toEqual([]);
  });

  it('treats v1 frontmatter as authoritative over duplicate runtime sections', () => {
    const parsed = parsePersonalityMarkdown(
      'stale-sections',
      `---
codeep: custom-bot/v1
---
# Stale Sections

## Responsibility
Talk through the problem.

## Model
openai/gpt-5.6-sol

## Tools
- Files

## Scope
Selected projects

## Projects
- old-project
`,
      'global',
    );
    expect(parsed.model).toBe('Automatic');
    expect(parsed.tools).toEqual([]);
    expect(parsed.scope).toBe('All projects');
    expect(parsed.projects).toEqual([]);
  });

  it('marks an explicit invalid structured scope unavailable', () => {
    const parsed = parsePersonalityMarkdown(
      'bad-scope',
      '---\ncodeep: custom-bot/v1\nscope: selectd\n---\n# Bad Scope\n',
      'global',
    );
    expect(parsed.scope).toBe('All projects');
    expect(parsed.available).toBe(false);
  });

  it('marks an explicit unsupported schema unavailable without legacy fallback', () => {
    const parsed = parsePersonalityMarkdown(
      'future-bot',
      `---
codeep: custom-bot/v2
---
# Future Bot

## Responsibility
Review releases.

## Model
automatic
`,
      'global',
    );
    expect(parsed.structured).toBe(true);
    expect(parsed.restrictTools).toBe(true);
    expect(parsed.tools).toEqual([]);
    expect(parsed.available).toBe(false);
  });
});

describe('loadPersonalities', () => {
  it('uses project > global > built-in priority', () => {
    const root = mkdtempSync(join(tmpdir(), 'codeep-personality-workspace-'));
    const home = mkdtempSync(join(tmpdir(), 'codeep-personality-home-'));
    mkdirSync(join(home, '.codeep', 'personalities'), { recursive: true });
    mkdirSync(join(root, '.codeep', 'personalities'), { recursive: true });
    writeFileSync(join(home, '.codeep', 'personalities', 'concise.md'), '# Global Concise\nGlobal.', 'utf8');
    writeFileSync(join(root, '.codeep', 'personalities', 'concise.md'), '# Project Concise\nProject.', 'utf8');

    const concise = loadPersonalities(root, home).find((item) => item.name === 'concise');
    expect(concise?.displayName).toBe('Project Concise');
    expect(concise?.source).toBe('project');
  });
});

describe('older CLI compatibility', () => {
  it('keeps legacy prompts selectable but disables unenforceable structured bots', () => {
    const legacy = parsePersonalityMarkdown('legacy', '# Legacy\nBe concise.', 'global');
    const structured = parsePersonalityMarkdown(
      'structured',
      '---\ncodeep: custom-bot/v1\ntools: [files]\n---\n# Structured',
      'global',
    );
    const result = personalitiesForLegacyCore([legacy, structured]);
    expect(result.find(item => item.name === 'legacy')?.available).toBe(true);
    expect(result.find(item => item.name === 'structured')?.available).toBe(false);
  });
});

describe('normalizeRpcPersonality', () => {
  it('accepts the canonical ACP custom-bot payload and preserves availability', () => {
    expect(normalizeRpcPersonality({
      name: 'release-guardian',
      displayName: 'Release Guardian',
      description: 'Owns release quality.',
      scope: 'global',
      model: 'openai/gpt-5.6-sol',
      tools: ['files', 'tests', 'git', 'mcp'],
      projectScope: 'selected',
      projects: ['Codeep'],
      available: false,
      structured: true,
      restrictTools: true,
    })).toMatchObject({
      name: 'release-guardian',
      source: 'global',
      model: 'openai/gpt-5.6-sol',
      tools: ['Files', 'Tests', 'Git', 'MCP'],
      scope: 'Selected projects',
      projects: ['Codeep'],
      available: false,
      structured: true,
      restrictTools: true,
    });
  });

  it('rejects unsafe personality ids from ACP', () => {
    expect(normalizeRpcPersonality({ name: '../escape' })).toBeNull();
  });
});
