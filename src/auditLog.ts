/**
 * Reading back the audit record the CLI writes.
 *
 * Every agent run started from this extension goes through `codeep acp`, which
 * runs the same agent loop the terminal does — so the record already exists in
 * `.codeep/audit/` without the extension doing anything. What was missing was a
 * way to read it without leaving the editor.
 *
 * This reads the files directly rather than asking the CLI. A subprocess for
 * what is a directory of JSON lines would be slower, would fail differently
 * when the CLI is missing, and would put a second copy of the format in the
 * argument list. The format is stable and shared — that is the point of it.
 *
 * The parsing is deliberately forgiving. A run in flight has a start and no
 * end; a crashed one may have a truncated last line. Neither is corruption and
 * neither should hide the rest of the record.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/** One thing an agent did, or was stopped from doing. Mirrors the CLI's
 *  `AuditEvent` — only the fields a reader needs are typed here. */
export interface AuditEvent {
  ts: number;
  run: string;
  tool?: string;
  action: string;
  target?: string;
  outcome?: 'ok' | 'error' | 'refused';
  detail?: string;
  agent?: string;
  capabilities?: string[];
  prompt?: string;
}

/** One run, reassembled from its lines. */
export interface AuditRun {
  run: string;
  startedAt: number;
  endedAt?: number;
  prompt?: string;
  agent?: string;
  capabilities?: string[];
  outcome?: 'ok' | 'error';
  detail?: string;
  events: AuditEvent[];
}

export function auditDirectory(workspaceRoot: string): string {
  return join(workspaceRoot, '.codeep', 'audit');
}

/**
 * Every event in the record, oldest first.
 *
 * A missing directory is the ordinary case — a project where no agent has run
 * yet — and returns nothing rather than throwing. A single unreadable file does
 * not hide the others: one bad day's log must not cost you the whole history.
 */
export function readAuditEvents(workspaceRoot: string): AuditEvent[] {
  const dir = auditDirectory(workspaceRoot);
  let names: string[];
  try {
    names = readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }

  const events: AuditEvent[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as AuditEvent;
        // A line without a run id cannot be grouped, and a run of orphans is
        // not a run. The last line of a crashed write looks exactly like this.
        if (parsed && typeof parsed.run === 'string' && parsed.run) events.push(parsed);
      } catch {
        /* a truncated final line is not corruption */
      }
    }
  }
  return events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

/**
 * Group events back into runs, newest first.
 *
 * A run still going has a start and no end, and is kept — it is the one you are
 * most likely to be looking at. Events arriving without a start (an older log
 * trimmed at the top) still form a run rather than being dropped, because a
 * refusal is worth seeing even when the line that opened its run is gone.
 */
export function groupAuditRuns(events: AuditEvent[], limit = 20): AuditRun[] {
  const byRun = new Map<string, AuditRun>();

  for (const event of events) {
    let run = byRun.get(event.run);
    if (!run) {
      run = { run: event.run, startedAt: event.ts ?? 0, events: [] };
      byRun.set(event.run, run);
    }
    if (event.action === 'run-start') {
      run.startedAt = event.ts ?? run.startedAt;
      run.prompt = event.prompt;
      run.agent = event.agent;
      run.capabilities = event.capabilities;
    } else if (event.action === 'run-end') {
      run.endedAt = event.ts;
      run.outcome = event.outcome === 'error' ? 'error' : 'ok';
      run.detail = event.detail;
    } else {
      run.events.push(event);
    }
  }

  return [...byRun.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}

/** Every refusal in a run. The entries the record exists for. */
export function refusals(run: AuditRun): AuditEvent[] {
  return run.events.filter(e => e.outcome === 'refused' || e.action === 'refused');
}

function duration(run: AuditRun): string {
  if (!run.endedAt) return 'running';
  const seconds = Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

/**
 * The record as Markdown, for a preview tab.
 *
 * Refusals are listed individually while ordinary work is summarised by kind: a
 * run that read forty files should be one line, and the one call the boundary
 * turned down should never be buried among them.
 */
export function formatAuditRuns(runs: AuditRun[], workspaceName: string): string {
  if (runs.length === 0) {
    return [
      `# Audit record — ${workspaceName}`,
      '',
      'No agent runs recorded in this project yet.',
      '',
      'Every run appends to `.codeep/audit/` — reads, writes, and the tool calls',
      'a capability boundary refused. File contents are never recorded.',
    ].join('\n');
  }

  const lines = [`# Audit record — ${workspaceName}`, ''];

  for (const run of runs) {
    const mark = run.outcome === 'error' ? '✗' : run.endedAt ? '✓' : '·';
    const who = run.agent ? ` · **${run.agent}**${run.capabilities?.length ? ` (${run.capabilities.join(', ')})` : ''}` : '';
    lines.push(`### ${mark} ${new Date(run.startedAt).toLocaleString()}${who} · ${duration(run)}`);
    if (run.prompt) lines.push('', `> ${run.prompt}`);

    const denied = refusals(run);
    const ordinary = run.events.filter(e => !denied.includes(e));

    if (ordinary.length) {
      const byAction = new Map<string, number>();
      for (const event of ordinary) byAction.set(event.action, (byAction.get(event.action) ?? 0) + 1);
      const summary = [...byAction.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([action, count]) => `${count} ${action}`)
        .join(', ');
      lines.push('', `${summary}`);
    }

    for (const refusal of denied) {
      lines.push('', `- ⨯ **refused** \`${refusal.tool ?? 'tool'}\` → \`${refusal.target ?? ''}\``);
      if (refusal.detail) lines.push(`  ${refusal.detail}`);
    }

    if (run.outcome === 'error' && run.detail) lines.push('', `**Did not finish:** ${run.detail}`);
    lines.push('');
  }

  lines.push('---', '', '_Paths and commands only — file contents are never recorded._');
  return lines.join('\n');
}
