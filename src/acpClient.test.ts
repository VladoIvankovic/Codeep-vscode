import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'os';
import { AcpClient } from './acpClient';

// These tests drive the JSON-RPC stream framing/dispatch via the `ingest()`
// test seam — the same buffer + flush() path the live stdout handler uses.
// The constructor doesn't spawn a process, so this is pure in-memory.

let client: AcpClient;
/** Collected (event, payload) pairs emitted during a test. */
let events: { type: string; payload: unknown }[];

function capture(...types: string[]): void {
  for (const t of types) client.on(t, (payload: unknown) => events.push({ type: t, payload }));
}

function notification(update: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update } }) + '\n';
}

beforeEach(() => {
  client = new AcpClient('codeep', tmpdir());
  events = [];
});

describe('framing', () => {
  it('emits a chunk for a complete agent_message_chunk notification', () => {
    capture('chunk');
    client.ingest(notification({ sessionUpdate: 'agent_message_chunk', content: { text: 'hello' } }));
    expect(events).toEqual([{ type: 'chunk', payload: 'hello' }]);
  });

  it('buffers a message split across two ingest() calls and emits once', () => {
    capture('chunk');
    const full = notification({ sessionUpdate: 'agent_message_chunk', content: { text: 'split' } });
    const mid = Math.floor(full.length / 2);
    client.ingest(full.slice(0, mid));
    expect(events).toHaveLength(0); // incomplete line — nothing yet
    client.ingest(full.slice(mid));
    expect(events).toEqual([{ type: 'chunk', payload: 'split' }]);
  });

  it('processes multiple newline-delimited messages in a single chunk', () => {
    capture('chunk');
    client.ingest(
      notification({ sessionUpdate: 'agent_message_chunk', content: { text: 'a' } }) +
        notification({ sessionUpdate: 'agent_message_chunk', content: { text: 'b' } }),
    );
    expect(events.map((e) => e.payload)).toEqual(['a', 'b']);
  });

  it('skips blank lines', () => {
    capture('chunk');
    client.ingest('\n\n' + notification({ sessionUpdate: 'agent_message_chunk', content: { text: 'x' } }) + '\n');
    expect(events).toEqual([{ type: 'chunk', payload: 'x' }]);
  });

  it('tolerates a malformed JSON line and still processes a valid following line', () => {
    capture('chunk');
    expect(() => client.ingest('not json at all\n')).not.toThrow();
    client.ingest(notification({ sessionUpdate: 'agent_message_chunk', content: { text: 'ok' } }));
    expect(events).toEqual([{ type: 'chunk', payload: 'ok' }]);
  });

  it('keeps an incomplete trailing line buffered until its newline arrives', () => {
    capture('chunk');
    client.ingest(notification({ sessionUpdate: 'agent_message_chunk', content: { text: 'one' } }).trimEnd()); // no newline
    expect(events).toHaveLength(0);
    client.ingest('\n');
    expect(events).toEqual([{ type: 'chunk', payload: 'one' }]);
  });
});

describe('dispatch', () => {
  it('routes thought / toolCall / toolCallUpdate / configOptions / plan', () => {
    capture('thought', 'toolCall', 'toolCallUpdate', 'configOptions', 'plan');
    client.ingest(notification({ sessionUpdate: 'agent_thought_chunk', content: { text: 'thinking' } }));
    client.ingest(notification({ sessionUpdate: 'tool_call', status: 'in_progress', title: 'Reading', toolCallId: 't1' }));
    client.ingest(notification({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }));
    client.ingest(notification({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'model' }] }));
    client.ingest(notification({ sessionUpdate: 'plan', entries: [{ title: 'step 1' }] }));

    expect(events.map((e) => e.type)).toEqual(['thought', 'toolCall', 'toolCallUpdate', 'configOptions', 'plan']);
    expect(events[0].payload).toBe('thinking');
    expect((events[1].payload as any).toolCallId).toBe('t1');
  });

  it('emits serverRequest for an inbound request (id + method, not pending)', () => {
    capture('serverRequest');
    client.ingest(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: { path: '/x' } }) + '\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('serverRequest');
    expect((events[0].payload as any).id).toBe(7);
  });

  it('ignores an unknown sessionUpdate kind without emitting or throwing', () => {
    capture('chunk', 'thought', 'toolCall', 'plan');
    expect(() => client.ingest(notification({ sessionUpdate: 'something_new', foo: 1 }))).not.toThrow();
    expect(events).toHaveLength(0);
  });
});

describe('manual-mode fail-closed gate', () => {
  it('starts un-armed (so send() would refuse until manual mode is confirmed)', () => {
    expect(client.isModeGuarded).toBe(false);
  });

  it('arms when the server confirms a session mode via current_mode_update', () => {
    capture('modeChanged');
    expect(client.isModeGuarded).toBe(false);
    client.ingest(notification({ sessionUpdate: 'current_mode_update', currentModeId: 'manual' }));
    expect(client.isModeGuarded).toBe(true);
    expect(events).toEqual([{ type: 'modeChanged', payload: 'manual' }]);
  });

  it('disarms on stop() so a reconnect must re-arm (no stale armed state carries over)', () => {
    client.ingest(notification({ sessionUpdate: 'current_mode_update', currentModeId: 'manual' }));
    expect(client.isModeGuarded).toBe(true);
    client.stop();
    expect(client.isModeGuarded).toBe(false);
  });
});
