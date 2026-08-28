import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readAuditEvents,
  groupAuditRuns,
  formatAuditRuns,
  refusals,
  type AuditEvent,
} from './auditLog';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-audit-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeLog(day: string, events: unknown[]): void {
  const dir = join(root, '.codeep', 'audit');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${day}.jsonl`), events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

const start = (run: string, ts: number, extra: Partial<AuditEvent> = {}) =>
  ({ ts, run, action: 'run-start', prompt: 'do the thing', ...extra });

describe('readAuditEvents', () => {
  /** A project where no agent has run yet is the ordinary case, not an error. */
  it('returns nothing for a project with no record', () => {
    expect(readAuditEvents(root)).toEqual([]);
  });

  it('reads every day and orders oldest first', () => {
    writeLog('2026-08-02', [start('b', 2000)]);
    writeLog('2026-08-01', [start('a', 1000)]);

    expect(readAuditEvents(root).map(e => e.run)).toEqual(['a', 'b']);
  });

  /**
   * The last line of a log written when the process died is often half a line.
   * That is not corruption, and it must not cost you the rest of the history.
   */
  it('skips a truncated final line and keeps the rest', () => {
    const dir = join(root, '.codeep', 'audit');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-08-01.jsonl'),
      JSON.stringify(start('a', 1000)) + '\n' + '{"ts":2000,"run":"b","act',
    );

    expect(readAuditEvents(root).map(e => e.run)).toEqual(['a']);
  });

  // A line with no run id cannot be grouped, and a run of orphans is not a run.
  it('drops lines with no run id', () => {
    writeLog('2026-08-01', [{ ts: 1, action: 'read' }, start('a', 2)]);
    expect(readAuditEvents(root).map(e => e.run)).toEqual(['a']);
  });
});

describe('groupAuditRuns', () => {
  it('reassembles a run from its lines, newest first', () => {
    writeLog('2026-08-01', [
      start('old', 1000, { agent: 'Git Only', capabilities: ['git'] }),
      { ts: 1100, run: 'old', tool: 'read_file', action: 'read', target: 'a.ts', outcome: 'ok' },
      { ts: 1200, run: 'old', action: 'run-end', outcome: 'ok' },
      start('new', 5000),
      { ts: 5100, run: 'new', action: 'run-end', outcome: 'ok' },
    ]);

    const runs = groupAuditRuns(readAuditEvents(root));

    expect(runs.map(r => r.run)).toEqual(['new', 'old']);
    const old = runs[1]!;
    expect(old.agent).toBe('Git Only');
    expect(old.capabilities).toEqual(['git']);
    expect(old.prompt).toBe('do the thing');
    expect(old.outcome).toBe('ok');
    // Run markers are not events the agent performed.
    expect(old.events).toHaveLength(1);
  });

  /** The run you are most likely looking at is the one still going. */
  it('keeps a run that has not ended', () => {
    writeLog('2026-08-01', [
      start('live', 1000),
      { ts: 1100, run: 'live', tool: 'read_file', action: 'read', target: 'a.ts', outcome: 'ok' },
    ]);

    const [run] = groupAuditRuns(readAuditEvents(root));
    expect(run!.endedAt).toBeUndefined();
    expect(run!.outcome).toBeUndefined();
  });

  /**
   * An older log trimmed at the top loses the opening line. The refusals in
   * what remains are still worth seeing, so events without a start still form
   * a run rather than being discarded.
   */
  it('keeps events whose run-start is gone', () => {
    writeLog('2026-08-01', [
      { ts: 1000, run: 'orphan', tool: 'execute_command', action: 'refused', target: 'rm -rf /', outcome: 'refused' },
    ]);

    const runs = groupAuditRuns(readAuditEvents(root));
    expect(runs).toHaveLength(1);
    expect(refusals(runs[0]!)).toHaveLength(1);
  });

  it('honours the limit, keeping the newest', () => {
    writeLog('2026-08-01', Array.from({ length: 30 }, (_, i) => start(`r${i}`, i * 100)));
    const runs = groupAuditRuns(readAuditEvents(root), 5);

    expect(runs).toHaveLength(5);
    expect(runs[0]!.run).toBe('r29');
  });
});

describe('formatAuditRuns', () => {
  it('says so plainly when there is nothing yet', () => {
    const text = formatAuditRuns([], 'my-project');
    expect(text).toContain('No agent runs recorded');
    expect(text).toContain('my-project');
  });

  /**
   * A run that read forty files should be one line; the one call the boundary
   * turned down must never be buried among them.
   */
  it('summarises ordinary work but lists every refusal', () => {
    writeLog('2026-08-01', [
      start('a', 1000, { agent: 'Git Only', capabilities: ['git'] }),
      ...Array.from({ length: 40 }, (_, i) => ({
        ts: 1000 + i, run: 'a', tool: 'read_file', action: 'read', target: `f${i}.ts`, outcome: 'ok',
      })),
      { ts: 2000, run: 'a', tool: 'execute_command', action: 'refused', target: 'rm -rf build', outcome: 'refused', detail: 'blocked by custom bot "Git Only"' },
      { ts: 2100, run: 'a', action: 'run-end', outcome: 'ok' },
    ]);

    const text = formatAuditRuns(groupAuditRuns(readAuditEvents(root)), 'p');

    expect(text).toContain('40 read');
    expect(text).not.toContain('f7.ts');
    expect(text).toContain('rm -rf build');
    expect(text).toContain('blocked by custom bot');
    expect(text).toContain('Git Only');
  });

  it('marks a run that did not finish, and says why', () => {
    writeLog('2026-08-01', [
      start('a', 1000),
      { ts: 1100, run: 'a', action: 'run-end', outcome: 'error', detail: 'API error: 401' },
    ]);

    const text = formatAuditRuns(groupAuditRuns(readAuditEvents(root)), 'p');
    expect(text).toContain('✗');
    expect(text).toContain('401');
  });

  it('promises no file contents, because there are none', () => {
    writeLog('2026-08-01', [start('a', 1000), { ts: 1100, run: 'a', action: 'run-end', outcome: 'ok' }]);
    expect(formatAuditRuns(groupAuditRuns(readAuditEvents(root)), 'p'))
      .toContain('file contents are never recorded');
  });
});
