import { describe, it, expect } from 'vitest';
import {
  validateMcpServerName,
  validateSkillBundleName,
  validateApiKey,
  validateModelId,
  validateRequired,
} from './validators';

describe('validateMcpServerName', () => {
  it('accepts a simple lowercase name', () => {
    expect(validateMcpServerName('postgres')).toBeNull();
  });

  it('accepts mixed case, digits, underscores, hyphens', () => {
    expect(validateMcpServerName('My-Server_1')).toBeNull();
  });

  it('accepts a single-letter name', () => {
    expect(validateMcpServerName('a')).toBeNull();
  });

  it('accepts the maximum 32-character length', () => {
    expect(validateMcpServerName('a' + 'b'.repeat(31))).toBeNull();
  });

  it('rejects a digit-first name', () => {
    expect(validateMcpServerName('1server')).toMatch(/must start with a letter/);
  });

  it('rejects a hyphen-first name', () => {
    expect(validateMcpServerName('-server')).toMatch(/must start with a letter/);
  });

  it('rejects a name longer than 32 chars', () => {
    expect(validateMcpServerName('a'.repeat(33))).toMatch(/max 32 chars/);
  });

  it('rejects an empty string', () => {
    expect(validateMcpServerName('')).toMatch(/must start with a letter/);
  });

  it('rejects disallowed characters (dots, slashes)', () => {
    expect(validateMcpServerName('my.server')).toBeTruthy();
    expect(validateMcpServerName('my/server')).toBeTruthy();
  });

  it('trims surrounding whitespace before validating', () => {
    expect(validateMcpServerName('  fs  ')).toBeNull();
  });
});

describe('validateSkillBundleName', () => {
  it('accepts a lowercase hyphenated name', () => {
    expect(validateSkillBundleName('deploy-staging')).toBeNull();
  });

  it('accepts a name starting with a digit', () => {
    expect(validateSkillBundleName('2fa-flow')).toBeNull();
  });

  it('rejects an uppercase letter anywhere', () => {
    expect(validateSkillBundleName('Deploy')).toBeTruthy();
  });

  it('rejects an uppercase first letter', () => {
    expect(validateSkillBundleName('Foo')).toBeTruthy();
  });

  it('accepts the maximum 41-character length', () => {
    expect(validateSkillBundleName('a' + 'b'.repeat(40))).toBeNull();
  });

  it('rejects a name longer than 41 chars', () => {
    expect(validateSkillBundleName('a'.repeat(42))).toMatch(/max 41 chars/);
  });

  it('rejects a hyphen-first name', () => {
    expect(validateSkillBundleName('-flow')).toMatch(/must start with/);
  });

  it('rejects an empty string', () => {
    expect(validateSkillBundleName('')).toBeTruthy();
  });
});

describe('validateApiKey', () => {
  it('accepts a realistic 40-char key', () => {
    expect(validateApiKey('sk-ant-' + 'a'.repeat(33))).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(validateApiKey('')).toBe('Key is empty');
  });

  it('rejects whitespace-only input', () => {
    expect(validateApiKey('   ')).toBe('Key is empty');
  });

  it('rejects embedded whitespace', () => {
    expect(validateApiKey('sk-1234 5678abcd1234')).toBe('Key contains whitespace — paste again');
    expect(validateApiKey('sk-1234\nabcd1234abcd12')).toBe('Key contains whitespace — paste again');
  });

  it('rejects a key shorter than 16 chars', () => {
    expect(validateApiKey('shortkey123')).toBe('Key looks too short — paste the full value');
  });

  it('accepts exactly 16 chars', () => {
    expect(validateApiKey('a'.repeat(16))).toBeNull();
  });

  it('trims surrounding whitespace before checking length', () => {
    // A clipboard copy with a trailing newline should still pass once
    // trimmed — the user can't see the whitespace.
    expect(validateApiKey('  ' + 'a'.repeat(20) + '  ')).toBeNull();
  });
});

describe('validateModelId', () => {
  it('accepts any non-empty string', () => {
    expect(validateModelId('claude-4-opus')).toBeNull();
    expect(validateModelId('gpt-5')).toBeNull();
    expect(validateModelId('x')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(validateModelId('')).toBe('Enter a model id');
  });

  it('rejects a whitespace-only string', () => {
    expect(validateModelId('   ')).toBe('Enter a model id');
  });

  it('accepts a string with internal whitespace', () => {
    // The trim check is only for emptiness, not internal spaces — some
    // custom model ids may include them (unusual, but not for us to
    // police at this layer).
    expect(validateModelId('my model')).toBeNull();
  });
});

describe('validateRequired', () => {
  it('accepts a non-empty description', () => {
    expect(validateRequired('deploy the branch')).toBeNull();
  });

  it('rejects an empty string with the default field name', () => {
    expect(validateRequired('')).toBe('Description is required');
  });

  it('uses the custom field name when provided', () => {
    expect(validateRequired('', 'Title')).toBe('Title is required');
  });

  it('rejects a whitespace-only string', () => {
    expect(validateRequired('   ')).toBe('Description is required');
  });
});
