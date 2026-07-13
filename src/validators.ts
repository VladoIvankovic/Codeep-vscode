/**
 * Input validators for Codeep command-palette flows.
 *
 * Each function matches the VS Code `InputBox.validateInput` signature:
 * return `null` for valid input, or an error string the box shows below
 * the input. Extracted from `extension.ts` so the rules (and their
 * error messages) are unit-testable and reusable from other surfaces.
 */

/**
 * Validate an MCP server name. Used as the agent-side tool prefix
 * (`<name>__<tool>`), so it must be identifier-like.
 *
 * Rules: starts with a letter, then letters / digits / `_` / `-`,
 * 1–32 characters total.
 */
export function validateMcpServerName(v: string): string | null {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(v.trim())
    ? null
    : 'Letters, digits, _ and - only; must start with a letter; max 32 chars';
}

/**
 * Validate a skill bundle name. Lowercase-only because it becomes a
 * directory name on disk and a catalog key the agent matches against.
 *
 * Rules: starts with a lowercase letter or digit, then lowercase
 * letters / digits / hyphens, 1–41 characters total.
 */
export function validateSkillBundleName(v: string): string | null {
  return /^[a-z0-9][a-z0-9-]{0,40}$/.test(v.trim())
    ? null
    : 'Lowercase letters / digits / hyphens; must start with a letter or digit; max 41 chars';
}

/**
 * Validate an API key pasted into the "Set API key" flow.
 *
 * Rules: non-empty, no whitespace (catches trailing newlines from a
 * clipboard mishap), at least 16 chars (every real provider key is
 * longer; anything shorter is almost certainly truncated).
 */
export function validateApiKey(v: string): string | null {
  const t = v.trim();
  if (!t) return 'Key is empty';
  if (/\s/.test(t)) return 'Key contains whitespace — paste again';
  if (t.length < 16) return 'Key looks too short — paste the full value';
  return null;
}

/**
 * Validate a free-text model id (used by providers whose model list is
 * dynamic, or when the CLI doesn't report models).
 *
 * Rules: must be non-empty after trimming.
 */
export function validateModelId(v: string): string | null {
  return v.trim() ? null : 'Enter a model id';
}

/**
 * Validate a skill bundle description (shown in the agent's catalog).
 *
 * Rules: must be non-empty after trimming.
 */
export function validateRequired(v: string, field = 'Description'): string | null {
  return v.trim().length > 0 ? null : `${field} is required`;
}
