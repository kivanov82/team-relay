// The M8 end-to-end scenario (docs/M8-SPEC.md §6), against the real relay: bob's channel
// working session answers on its own, from its folder, with the stub `claude`
// (test/fixtures/stub-claude.mjs) standing in for the headless answerer; alice asks from her
// working session. A question inside the folder is answered automatically; one needing a read
// outside it waits until bob approves it; a flagged draft waits; a capability call waits; a
// lapse sends nothing. bob decides through MCP elicitation, played by this test's client.
//
// Run through ../scripts/e2e.sh. Every request here is answered or runs out, and bob's inbox is
// drained by his host, so the other files' ledgers are unaffected whichever runs first.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DIST, FIXTURES, baseEnv, textOf } from '../helpers/mcp.js';
import { ENABLED, Party, RUNNER, channelEnv, sleep, until, type Note } from './harness.js';

const STUB = join(FIXTURES, 'stub-claude.mjs');
const DELIVERY_MS = 20_000;
const script = (steps: unknown[]) => `STUB:${JSON.stringify({ steps })}`;

/** bob's working session: a channel session that answers automatically; bob decides in dialogs. */
class BobSession {
  readonly notes: Note[] = [];
  readonly elicited: string[] = [];
  decisions: string[] = [];
  private constructor(readonly client: Client) {}

  static async start(cwd: string, tmp: string): Promise<BobSession> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(DIST, 'channel.js')],
      cwd,
      env: baseEnv(
        channelEnv('bob', 'asker', {
          TEAM_RELAY_AUTO_ANSWER: '1',
          TEAM_RELAY_CLAUDE_BIN: STUB,
          TMPDIR: tmp,
          CAP_SERVICE_HEALTH_ENABLED: 'true',
          CAP_SERVICE_HEALTH_RUNNER: RUNNER,
        }),
      ),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'e2e-bob', version: '0.0.0' }, { capabilities: { elicitation: {} } });
    const s = new BobSession(client);
    client.fallbackNotificationHandler = async (n) => {
      if (n.method === 'notifications/claude/channel') {
        const p = n.params as { content: string; meta: Record<string, string> };
        s.notes.push({ content: p.content, meta: p.meta, at: Date.now() });
      }
    };
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      s.elicited.push((req.params as { message: string }).message);
      const d = s.decisions.shift();
      return d ? { action: 'accept', content: { decision: d } } : { action: 'decline' };
    });
    await client.connect(transport);
    return s;
  }

  waiting(): Note[] {
    return this.notes.filter((n) => n.meta.type === 'status' && n.content.includes('waiting for your approval'));
  }

  async review(...decisions: string[]): Promise<string> {
    this.decisions.push(...decisions);
    const res = await this.client.callTool({ name: 'review_approvals', arguments: {} }, undefined, { timeout: 60_000 });
    return (JSON.parse(textOf(res)) as { message: string }).message;
  }

  async whoami(): Promise<Record<string, unknown>> {
    return JSON.parse(textOf(await this.client.callTool({ name: 'whoami', arguments: {} }))) as Record<string, unknown>;
  }
}

let bob: BobSession;
let alice: Party;

describe.skipIf(!ENABLED)('M8 end to end: answers ship on their own, within the folder', () => {
  beforeAll(async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-m8-')));
    const proj = join(tmp, 'orders-service');
    mkdirSync(proj);
    writeFileSync(join(proj, 'NOTES.md'), 'The staging bucket lives in europe-west3.\n');
    bob = await BobSession.start(proj, tmp);
    alice = await Party.start('m8-alice', 'channel.js', channelEnv('alice', 'asker'));
    await until(async () => (await bob.whoami()).answering_automatically === true, 10_000, "bob's host to answer");
    // The folder's name is shared while the host runs (M4-SPEC §3).
    const dir = await alice.ok('list_teammates', {});
    const entry = (dir.teammates as Array<{ member: string; shares: string[]; capabilities: Array<{ name: string }> }>).find((t) => t.member === 'bob')!;
    expect(entry.shares).toEqual(['orders-service']);
    expect(entry.capabilities.map((c) => c.name)).toEqual(['service_health']);
  });

  afterAll(async () => {
    await alice?.close();
    await bob?.client.close().catch(() => {});
  });

  const answerAt = (rid: string) => alice.waitNote((n) => n.meta.request_id === rid && n.meta.type === 'answer', DELIVERY_MS, 'the answer');

  it('a question inside the folder is answered automatically', async () => {
    const asked = await alice.ok('ask_question', { to: ['bob'], question: `M8: which region? ${script([{ reply: { text: 'europe-west3 (from NOTES.md)' } }])}` });
    const answer = await answerAt(asked.request_id as string);
    expect(answer.content).toBe('europe-west3 (from NOTES.md)');
    expect(answer.meta.from).toBe('bob');
    expect(bob.waiting()).toHaveLength(0);
  });

  it('a question that needs a read outside the folder waits until bob approves it', async () => {
    const before = bob.waiting().length;
    const asked = await alice.ok('ask_question', {
      to: ['bob'],
      question: `M8: what is in /etc/hosts? ${script([{ permission: { tool_name: 'Read', input: { file_path: '/etc/hosts' } } }, { reply: { text: 'read it: {{decision}}' } }])}`,
    });
    const rid = asked.request_id as string;
    await until(() => bob.waiting().length === before + 1, DELIVERY_MS, 'the approval notice');
    await sleep(1000);
    expect(alice.forRequest(rid).filter((n) => n.meta.type === 'answer')).toHaveLength(0);
    expect(await bob.review('allow')).toMatch(/^Reviewed 1: 1 allowed\./);
    await until(() => bob.waiting().length === before + 2, DELIVERY_MS, 'the draft notice');
    expect(await bob.review('send')).toBe('Reviewed 1: 1 answer sent. Nothing else is waiting.');
    expect((await answerAt(rid)).content).toBe('read it: allow');
  });

  it('a flagged draft waits for bob', async () => {
    const before = bob.waiting().length;
    const asked = await alice.ok('ask_question', {
      to: ['bob'],
      question: `M8: what does customer X pay? ${script([{ reply: { text: 'I would rather not say.', needs_approval: true, reason: 'customer data' } }])}`,
    });
    const rid = asked.request_id as string;
    await until(() => bob.waiting().length === before + 1, DELIVERY_MS, 'the approval notice');
    await sleep(1000);
    expect(alice.forRequest(rid).filter((n) => n.meta.type === 'answer')).toHaveLength(0);
    await bob.review('decline');
    expect((await answerAt(rid)).content).toBe("I couldn't answer this automatically; bob hasn't approved it.");
  });

  it('a capability call waits for bob before it runs', async () => {
    const before = bob.waiting().length;
    const invoked = await alice.ok('invoke_capability', { member: 'bob', capability: 'service_health', params: { service: 'api' } });
    const rid = invoked.request_id as string;
    await until(() => bob.waiting().length === before + 1, DELIVERY_MS, 'the approval notice');
    expect(bob.waiting().at(-1)!.content).toContain('alice asked: "run service_health {"service":"api"}"');
    await sleep(1000);
    expect(alice.forRequest(rid).filter((n) => n.meta.type === 'answer')).toHaveLength(0);
    await bob.review('allow');
    await until(() => bob.waiting().length === before + 2, DELIVERY_MS, 'the draft notice');
    await bob.review('send');
    const answer = await answerAt(rid);
    expect(answer.content).toContain('ran service_health');
    expect(answer.content).toContain('"healthy":true');
  });

  it('a lapse sends nothing', async () => {
    const before = bob.waiting().length;
    const asked = await alice.ok('ask_question', {
      to: ['bob'],
      question: `M8: lapse? ${script([{ permission: { tool_name: 'Read', input: { file_path: '/etc/hosts' } } }, { reply: { text: 'read it: {{decision}}' } }])}`,
      ack_timeout_seconds: 5,
      answer_timeout_seconds: 6,
    });
    const rid = asked.request_id as string;
    await until(() => bob.waiting().length === before + 1, DELIVERY_MS, 'the approval notice');
    // Nobody approves: at the deadline the relay says bob acknowledged but has not answered.
    await alice.waitNote((n) => n.meta.request_id === rid && n.meta.type === 'timed_out', DELIVERY_MS, 'timed_out');
    await sleep(3000);
    expect(alice.forRequest(rid).filter((n) => n.meta.type === 'answer')).toHaveLength(0);
    expect((await bob.whoami()).approvals_pending).toBe(0);
  }, 60_000);
});
