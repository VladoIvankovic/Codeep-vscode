import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type PersonalitySource = 'builtin' | 'global' | 'project';
export type PersonalityTool = 'Files' | 'Terminal' | 'Tests' | 'Git' | 'Web' | 'MCP';
export type PersonalityScope = 'All projects' | 'Selected projects' | 'Personal mode only';

export interface PersonalityDefinition {
  name: string;
  displayName: string;
  description: string;
  source: PersonalitySource;
  /** `Automatic` or an exact `provider/model` id. */
  model: string;
  /** Declared normalized tool groups; empty may mean none or unspecified. */
  tools: PersonalityTool[];
  scope: PersonalityScope;
  projects: string[];
  /** custom-bot/v1 frontmatter or compatible structured Markdown sections. */
  structured: boolean;
  /** True only when runtime tool restriction was explicitly declared. */
  restrictTools: boolean;
  /** Core-computed availability for the current workspace/mode. */
  available: boolean;
  filePath?: string;
}

const BUILTIN: PersonalityDefinition[] = [
  ['concise', 'Concise', 'Short answers, no preamble, and no filler.'],
  ['verbose', 'Verbose', 'Detailed explanations with rationale and caveats.'],
  ['security', 'Security-paranoid', 'Treats inputs as untrusted and prefers defensive code.'],
  ['senior-reviewer', 'Senior reviewer', 'Strong opinions on architecture, naming, and test gaps.'],
  ['junior-mentor', 'Junior mentor', 'Explains concepts as it works and suggests what to learn next.'],
  ['ship-it', 'Ship it', 'Optimizes for a focused, minimum-viable path to merge.'],
].map(([name, displayName, description]) => ({
  name,
  displayName,
  description,
  source: 'builtin' as const,
  model: 'Automatic',
  tools: [],
  scope: 'All projects' as const,
  projects: [],
  structured: false,
  restrictTools: false,
  available: true,
}));

const TOOL_LABELS: Record<string, PersonalityTool> = {
  files: 'Files',
  terminal: 'Terminal',
  tests: 'Tests',
  git: 'Git',
  web: 'Web',
  mcp: 'MCP',
};

const SCOPE_LABELS: Record<string, PersonalityScope> = {
  all: 'All projects',
  'all projects': 'All projects',
  selected: 'Selected projects',
  'selected projects': 'Selected projects',
  personal: 'Personal mode only',
  'personal mode only': 'Personal mode only',
};

function cleanScalar(value: string | undefined): string {
  return (value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

function parseInlineList(value: string | undefined, requireBrackets = false): string[] {
  const text = cleanScalar(value);
  if (!text) return [];
  if (requireBrackets && !(text.startsWith('[') && text.endsWith(']'))) return [];
  const body = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  return body
    .split(',')
    .map((item) => cleanScalar(item))
    .filter(Boolean);
}

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } | null {
  const normalized = raw.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) return null;
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*?)\s*$/);
    if (field) fields[field[1].toLowerCase()] = field[2];
  }
  return { fields, body: normalized.slice(match[0].length) };
}

function markdownSections(body: string): Map<string, string> {
  const matches = [...body.matchAll(/^##\s+(.+?)\s*$/gm)];
  const sections = new Map<string, string>();
  for (let index = 0; index < matches.length; index++) {
    const current = matches[index];
    const start = (current.index ?? 0) + current[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? body.length) : body.length;
    sections.set(current[1].trim().toLowerCase(), body.slice(start, end).trim());
  }
  return sections;
}

function markdownList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1]?.trim() ?? '')
    .filter(Boolean);
}

function normalizeTools(values: string[]): PersonalityTool[] {
  const seen = new Set<PersonalityTool>();
  for (const value of values) {
    const tool = TOOL_LABELS[value.trim().toLowerCase()];
    if (tool) seen.add(tool);
  }
  return [...seen];
}

function displayNameFromBody(body: string, fallbackName: string): string {
  return body.match(/^#\s+(?:Personality:\s+)?(.+?)\s*$/m)?.[1]?.trim() || fallbackName;
}

function descriptionFromBody(body: string, sections: Map<string, string>, fallbackName: string): string {
  const quote = body.match(/^>\s*(.+?)\s*$/m)?.[1]?.trim();
  if (quote) return quote.slice(0, 240);
  const responsibility = sections.get('responsibility')?.replace(/\s+/g, ' ').trim();
  if (responsibility) return responsibility.slice(0, 240);

  // Legacy files use their first prose paragraph as the description. Ignore
  // headings/list-only paragraphs so metadata is never presented as prose.
  const withoutH1 = body.replace(/^#\s+.+?\s*$/m, '').trim();
  const paragraph = withoutH1
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .find((part) => part && !part.startsWith('#') && !part.startsWith('- '));
  return (paragraph || `Custom bot ${fallbackName}`).slice(0, 240);
}

/** Parse both custom-bot/v1 and the older section-only personality format. */
export function parsePersonalityMarkdown(
  name: string,
  raw: string,
  source: Exclude<PersonalitySource, 'builtin'>,
  filePath?: string,
): PersonalityDefinition {
  const normalizedRaw = raw.replace(/^\uFEFF/, '');
  const frontmatter = parseFrontmatter(normalizedRaw);
  const body = frontmatter?.body ?? normalizedRaw;
  const fields = frontmatter?.fields ?? {};
  const sections = markdownSections(body);
  const codeepDeclared = Object.prototype.hasOwnProperty.call(fields, 'codeep');
  const hasFrontmatter = cleanScalar(fields.codeep) === 'custom-bot/v1';
  const standardSections = [
    'responsibility', 'response style', 'always', 'never', 'advanced instructions', 'model', 'tools', 'scope', 'projects',
  ];
  const presentSectionCount = standardSections.filter((key) => sections.has(key)).length;
  const hasStructuredSections = !codeepDeclared && sections.has('responsibility') && presentSectionCount >= 2;
  const structured = codeepDeclared || hasStructuredSections;
  const schemaValid = !codeepDeclared || hasFrontmatter;
  const restrictTools = codeepDeclared || (hasStructuredSections && sections.has('tools'));

  const sectionTools = markdownList(sections.get('tools'));
  const tools = restrictTools
    ? normalizeTools(codeepDeclared ? (hasFrontmatter ? parseInlineList(fields.tools, true) : []) : sectionTools)
    : [];
  const modelValue = cleanScalar(codeepDeclared ? (hasFrontmatter ? fields.model : undefined) : sections.get('model'));
  const scopeValue = cleanScalar(codeepDeclared ? (hasFrontmatter ? fields.scope : undefined) : sections.get('scope')).toLowerCase();
  const scopeDeclared = (hasFrontmatter && fields.scope !== undefined)
    || (hasStructuredSections && sections.has('scope'));
  const normalizedScope = SCOPE_LABELS[scopeValue];
  const scopeValid = !structured || !scopeDeclared || normalizedScope !== undefined;
  const projects = hasFrontmatter
    ? parseInlineList(fields.projects, true)
    : hasStructuredSections
      ? markdownList(sections.get('projects'))
      : [];
  const frontmatterDescription = cleanScalar(fields.description);
  const modelValid = !structured
    || !modelValue
    || modelValue.toLowerCase() === 'automatic'
    || /^[^/\s]+\/.+/.test(modelValue);
  const selectedProjectsValid = normalizedScope !== 'Selected projects' || projects.length > 0;

  return {
    name: name.toLowerCase(),
    displayName: displayNameFromBody(body, name),
    description: frontmatterDescription || descriptionFromBody(body, sections, name),
    source,
    model: !structured || !modelValue || modelValue.toLowerCase() === 'automatic'
      ? 'Automatic'
      : modelValue,
    tools,
    scope: !structured ? 'All projects' : (normalizedScope ?? 'All projects'),
    projects,
    structured,
    restrictTools,
    available: schemaValid && scopeValid && modelValid && selectedProjectsValid,
    filePath,
  };
}

function loadDirectory(
  directory: string,
  source: Exclude<PersonalitySource, 'builtin'>,
): PersonalityDefinition[] {
  if (!existsSync(directory)) return [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const personalities: PersonalityDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.slice(0, -3).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) continue;
    const filePath = join(directory, entry);
    try {
      const raw = readFileSync(filePath, 'utf8');
      if (raw.length > 64 * 1024) continue;
      personalities.push(parsePersonalityMarkdown(name, raw, source, filePath));
    } catch {
      // A malformed or unreadable custom file must not break the entire picker.
    }
  }
  return personalities;
}

/** Mirrors CLI priority: project overrides global, which overrides built-in. */
export function loadPersonalities(workspaceRoot?: string, homeDirectory = homedir()): PersonalityDefinition[] {
  const byName = new Map<string, PersonalityDefinition>();
  for (const personality of BUILTIN) byName.set(personality.name, personality);
  for (const personality of loadDirectory(join(homeDirectory, '.codeep', 'personalities'), 'global')) {
    byName.set(personality.name, personality);
  }
  if (workspaceRoot) {
    for (const personality of loadDirectory(join(workspaceRoot, '.codeep', 'personalities'), 'project')) {
      byName.set(personality.name, personality);
    }
  }
  return [...byName.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function personalityDetail(personality: PersonalityDefinition): string {
  const tools = personality.restrictTools
    ? (personality.tools.length > 0 ? personality.tools.join(', ') : 'None')
    : 'Unrestricted';
  const scope = personality.scope === 'Selected projects' && personality.projects.length > 0
    ? `${personality.scope}: ${personality.projects.join(', ')}`
    : personality.scope;
  // Git reads committed file contents (`git show HEAD:file`), so a Git-without-
  // Files bot is not one you can point at a repo whose contents it must not
  // see. This line is where the bot is picked, so flag it here too.
  const readsFiles = personality.restrictTools
    && personality.tools.includes('Git')
    && !personality.tools.includes('Files');
  return `${personality.model} · ${tools}${readsFiles ? ' (Git reads and writes files)' : ''} · ${scope}`;
}

/** Older CLIs can apply prompt text but cannot enforce structured runtime controls. */
export function personalitiesForLegacyCore(
  personalities: PersonalityDefinition[],
): PersonalityDefinition[] {
  return personalities.map((personality) => personality.structured
    ? { ...personality, available: false }
    : personality);
}

/** Validate the optional ACP payload before it crosses into the Webview. */
export function normalizeRpcPersonality(value: unknown): PersonalityDefinition | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const name = typeof item.name === 'string' ? item.name.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;
  const rawOrigin = typeof item.source === 'string' ? item.source : item.scope;
  const source: PersonalitySource = rawOrigin === 'project' || rawOrigin === 'global' || rawOrigin === 'builtin'
    ? rawOrigin
    : 'global';
  const rawBotScope = typeof item.projectScope === 'string'
    ? item.projectScope
    : typeof item.botScope === 'string'
      ? item.botScope
      : (rawOrigin === source ? '' : item.scope);
  const scopeKey = typeof rawBotScope === 'string' ? rawBotScope.toLowerCase() : '';
  const normalizedScope = SCOPE_LABELS[scopeKey];
  const tools = Array.isArray(item.tools)
    ? normalizeTools(item.tools.filter((tool): tool is string => typeof tool === 'string'))
    : [];
  const projects = Array.isArray(item.projects)
    ? item.projects.filter((project): project is string => typeof project === 'string').map((project) => project.trim()).filter(Boolean)
    : [];
  const structured = item.structured !== false && source !== 'builtin';
  const restrictTools = typeof item.restrictTools === 'boolean'
    ? item.restrictTools && structured
    : structured;
  return {
    name,
    displayName: typeof item.displayName === 'string' && item.displayName.trim() ? item.displayName.trim() : name,
    description: typeof item.description === 'string' ? item.description.trim().slice(0, 240) : '',
    source,
    model: typeof item.model === 'string' && item.model.trim() && item.model.toLowerCase() !== 'automatic'
      ? item.model.trim()
      : 'Automatic',
    tools,
    scope: normalizedScope ?? 'All projects',
    projects,
    structured,
    restrictTools,
    available: item.available !== false && (!structured || !scopeKey || normalizedScope !== undefined),
    filePath: typeof item.filePath === 'string' ? item.filePath : undefined,
  };
}
