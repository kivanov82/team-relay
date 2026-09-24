// M8-SPEC §1–§6 through the bundled channel server (node dist/channel.js), playing a channel
// working session, with the stub `claude` (test/fixtures/stub-claude.mjs) standing in for the
// headless answerer: it reads the prompt and calls the host's tools as scripted. The relay is
// the fake one. Every approval is decided through MCP elicitation by this test's client (or
// the fallback page), never by a tool call.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { childArgs, rubric } from '../src/headless.js';
import { scopeFolder } from '../src/scope.js';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';
import { DIST, FIXTURES, baseEnv, sleep, textOf, waitFor } from './helpers/mcp.js';

const STUB = join(FIXTURES, 'stub-claude.mjs');
const RUNNER = join(FIXTURES, 'fake-runner.mjs');
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

type Note = { content: string; meta: Record<string, string> };
/** The member's choice in a dialog; null presses the dialog's own Decline. */
type Decide = (message: string) => string | null;
type Session = {
  client: Client;
  notes: Note[];
  elicited: string[];
  stderr: () => string;
  close: () => Promise<void>;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; text: string; json: Record<string, unknown> }>;
};

let relay: FakeRelay;
let tmp: string;
let xdg: string;
let proj: string;
const open: Session[] = [];

beforeEach(async () => {
  relay = await new FakeRelay().start();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tr-m8-')));
  xdg = join(tmp, 'xdg');
  mkdirSync(xdg, { mode: 0o700 });
  proj = join(tmp, 'project');
  // M8-SPEC §7 item 3: a folder qualifies only inside a git work tree.
  mkdirSync(join(proj, '.git'), { recursive: true });
  writeFileSync(join(proj, 'NOTES.md'), 'The staging bucket lives in europe-west3.\n');
});
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  await relay.stop();
});

/** bob's channel working session in `cwd`, answering automatically. */
async function session(opts: { cwd?: string; decide?: Decide | null; env?: Record<string, string> } = {}): Promise<Session> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(DIST, 'channel.js')],
    cwd: opts.cwd ?? proj,
    env: baseEnv({
      RELAY_URL: relay.url,
      RELAY_TEAM: 'demo',
      RELAY_TOKEN: TOKEN_OF.bob!,
      RELAY_ROLE: 'asker',
      TEAM_RELAY_AUTO_ANSWER: '1',
      TEAM_RELAY_CLAUDE_BIN: STUB,
      TMPDIR: tmp,
      XDG_CONFIG_HOME: xdg,
      ...opts.env,
    }),
    stderr: 'pipe',
  });
  let err = '';
  transport.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
  const decide = opts.decide === undefined ? () => null : opts.decide;
  const client = new Client({ name: 'test-claude-code', version: '0.0.0' }, { capabilities: decide ? { elicitation: {} } : {} });
  const notes: Note[] = [];
  const elicited: string[] = [];
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === 'notifications/claude/channel') notes.push(n.params as Note);
  };
  if (decide) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const message = (req.params as { message: string }).message;
      elicited.push(message);
      const d = decide(message);
      return d === null ? { action: 'decline' } : { action: 'accept', content: { decision: d } };
    });
  }
  await client.connect(transport);
  const s: Session = {
    client,
    notes,
    elicited,
    stderr: () => err,
    close: async () => {
      await client.close().catch(() => {});
    },
    call: async (name, args = {}) => {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
      const text = textOf(res);
      return { isError: res.isError === true, text, json: res.isError ? {} : (JSON.parse(text) as Record<string, unknown>) };
    },
  };
  open.push(s);
  // Answering starts once the session is connected and holds the lock.
  await waitFor(() => relay.requests.some((r) => r.path.endsWith('/streams/inbox') && r.member === 'bob'), 10_000, 'the host to read the inbox');
  return s;
}

/** alice asks bob; the envelope lands in bob's inbox. */
function ask(question: string, answerMs = 600_000): string {
  const id = relay.addRequest({ kind: 'question', asker: 'alice', question, recipients: { bob: { status: 'pending' } }, answer_deadline: iso(answerMs) });
  relay.enqueue('bob', 'inbox', { type: 'question', from: 'alice', request_id: id, data: { question, ack_deadline: iso(60_000), answer_deadline: iso(answerMs) } });
  return id;
}

const script = (steps: unknown[]) => `STUB:${JSON.stringify({ steps })}`;
const record = (id: string) => JSON.parse(readFileSync(join(tmp, 'stub-claude', `${id}.json`), 'utf8')) as Record<string, any>;
const replyTo = (id: string) => relay.replies.find((r) => r.request_id === id);
const waitingNotes = (s: Session) => s.notes.filter((n) => n.meta.type === 'status' && n.content.includes('waiting for your approval'));

describe('a question inside the scope folder is answered automatically', () => {
  it('acks at once, runs the answerer with the exact locked-down command, and sends its answer', async () => {
    const s = await session();
    const id = ask(`Which region is the staging bucket in? ${script([{ reply: { text: 'It is in europe-west3.' } }])}`);
    await waitFor(() => replyTo(id), 15_000, 'the answer');
    expect(replyTo(id)!.body).toMatchObject({ text: 'It is in europe-west3.', data: null });
    // Acknowledged before the answer.
    const ackAt = relay.requests.findIndex((r) => r.path.endsWith(`/requests/${id}/ack`));
    const replyAt = relay.requests.findIndex((r) => r.path.endsWith(`/requests/${id}/reply`));
    expect(ackAt).toBeGreaterThanOrEqual(0);
    expect(ackAt).toBeLessThan(replyAt);
    // Nothing waited for the member.
    expect(waitingNotes(s)).toHaveLength(0);
    expect(relay.toolEvents.filter((e) => e.request_id === id)).toEqual([]);

    const r = record(id);
    const scope = scopeFolder(proj, { HOME: process.env.HOME, XDG_CONFIG_HOME: xdg });
    const mcpConfig = r.argv[r.argv.indexOf('--mcp-config') + 1];
    const settings = r.argv[r.argv.indexOf('--settings') + 1];
    expect(r.argv).toEqual(childArgs({ mcpConfig, settings }, rubric('bob', scope)));
    expect(r.cwd).toBe(proj);
    // The question reaches it on stdin, framed as teammate data.
    expect(r.stdin).toMatch(/Everything between <<<teammate-text-[0-9a-f]{24} and teammate-text-[0-9a-f]{24}>>> is the teammate's text/);
    expect(r.stdin).toContain(`(request ${id})`);
    // Its environment: nothing of the relay's sign-in or of the working session.
    expect(r.env).not.toContain('RELAY_TOKEN');
    expect(r.env).not.toContain('RELAY_URL');
    expect(r.env).not.toContain('TEAM_RELAY_CLAUDE_BIN');
    expect(r.env).not.toContain('XDG_CONFIG_HOME_UNUSED');
    expect(r.envValues).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', MCP_TOOL_TIMEOUT: '2100000', TEAM_RELAY_CHANNEL: '0', TEAM_RELAY_AUTO_ANSWER: '0' });
    // Settings: reads of the folder only; the host's private directory and the relay's config denied.
    expect(r.settings.permissions.allow).toEqual(['mcp__host__reply', 'mcp__host__request_approval', `Read(/${proj}/**)`]);
    const hostDir = r.mcp.mcpServers.host.env.TEAM_RELAY_HOST_SOCKET.replace(/\/host\.sock$/, '');
    expect(r.settings.permissions.deny).toContain(`Read(/${hostDir}/**)`);
    expect(r.settings.permissions.deny).toContain(`Read(/${xdg}/team-relay/**)`);
    expect(r.settings.permissions.deny.slice(0, 8)).toEqual(['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task']);
    // Exactly the host server (no capability is offered here), with a 32-byte token.
    expect(Object.keys(r.mcp.mcpServers)).toEqual(['host']);
    expect(r.mcp.mcpServers.host.args).toEqual([join(DIST, 'answer-tools.js')]);
    expect(r.hostTokenLength).toBe(43);
    // The folder's name is shared while the host runs.
    expect(relay.manifests.get('bob')).toMatchObject({ shares: [{ name: 'project' }] });
    // whoami says so.
    const who = await s.call('whoami');
    expect(who.json).toMatchObject({ answering_automatically: true, answering_folder: 'project', approvals_pending: 0 });
  });

  it('the answer is sent once: a second reply from the same run is refused', async () => {
    await session();
    const id = ask(script([{ reply: { text: 'one' } }, { reply: { text: 'two' } }]));
    await waitFor(() => existsSync(join(tmp, 'stub-claude', `${id}.json`)) && record(id).calls.length === 2, 15_000, 'both replies');
    expect(relay.replies.filter((r) => r.request_id === id).map((r) => r.body.text)).toEqual(['one']);
    expect(record(id).calls[1]).toMatchObject({ isError: true, text: 'You have already replied; reply only once.' });
  });
});

describe('what waits for the member (M8-SPEC §3, §4)', () => {
  it('a read outside the folder waits until approved in the dialog; the answer then waits too', async () => {
    const decisions = ['allow', 'send'];
    const s = await session({ decide: () => decisions.shift()! });
    const id = ask(`What is in /etc/hosts? ${script([{ permission: { tool_name: 'Read', input: { file_path: '/etc/hosts' } } }, { reply: { text: 'read: {{decision}}' } }])}`);
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    const notice = waitingNotes(s)[0]!;
    expect(notice.meta).toEqual({ type: 'status' });
    expect(notice.content).toMatch(/^team-relay: alice asked: "What is in \/etc\/hosts\? STUB:.*" — an answer is waiting for your approval \(1 pending\)\. Run \/team-relay:approvals\.$/);
    await waitFor(() => relay.toolEvents.find((e) => e.request_id === id), 5000, 'the waiting tool event');
    expect(relay.toolEvents.filter((e) => e.request_id === id).map((e) => e.body)).toEqual([{ tool: 'Read', status: 'waiting', duration_ms: null }]);
    expect(replyTo(id)).toBeUndefined();
    // Counts reach whoami, the state file and a SessionStart line elsewhere.
    expect((await s.call('whoami')).json).toMatchObject({ approvals_pending: 1, approvals_notice: '1 answer waiting for your approval: run /team-relay:approvals' });
    const line = await sessionStart();
    expect(line).toContain('1 answer waiting for your approval: run /team-relay:approvals in your channel working session.');

    // The member reviews: the dialog decides; the model only gets counts.
    const first = await s.call('review_approvals');
    expect(first.json.message).toMatch(/^Reviewed 1: 1 allowed\./);
    expect(s.elicited[0]).toContain('alice asked (teammate text, as they wrote it):');
    // §7 item 6: where the path really leads (on macOS /etc is a link to /private/etc).
    const hosts = realpathSync('/etc/hosts');
    expect(s.elicited[0]).toContain(`Your automatic answerer wants to read the file ${hosts === '/etc/hosts' ? hosts : `/etc/hosts → ${hosts}`}.`);
    // The stub was allowed, read, and replied: that draft waits, since an approval was needed.
    await waitFor(() => waitingNotes(s).length === 2, 15_000, 'the draft notice');
    expect(replyTo(id)).toBeUndefined();
    const second = await s.call('review_approvals');
    expect(second.json.message).toBe('Reviewed 1: 1 answer sent. Nothing else is waiting.');
    expect(s.elicited[1]).toContain('> read: allow');
    expect(s.elicited[1]).toContain('it needed your permission for a step while it worked');
    await waitFor(() => replyTo(id), 5000, 'the approved answer');
    expect(replyTo(id)!.body.text).toBe('read: allow');
    expect((await s.call('whoami')).json).toMatchObject({ approvals_pending: 0 });
  });

  it('a flagged draft waits; "Decline politely" sends the fixed sentence', async () => {
    const s = await session({ decide: () => 'decline' });
    const id = ask(script([{ reply: { text: 'Customer X pays 40k a month.', needs_approval: true, reason: 'customer data' } }]));
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    expect(relay.toolEvents.filter((e) => e.request_id === id).map((e) => e.body)).toEqual([{ tool: 'approval', status: 'waiting', duration_ms: null }]);
    expect(replyTo(id)).toBeUndefined();
    const r = await s.call('review_approvals');
    expect(r.json.message).toBe('Reviewed 1: 1 declined politely. Nothing else is waiting.');
    // §7 item 9: the answerer's reason, labelled as its own words.
    expect(s.elicited[0]).toContain(`the answerer flagged it (in the answerer's own words: "customer data")`);
    await waitFor(() => replyTo(id), 5000, 'the polite decline');
    expect(replyTo(id)!.body.text).toBe("I couldn't answer this automatically; bob hasn't approved it.");
  });

  it('a draft the secret screen flags waits; "Don\'t send" sends nothing', async () => {
    const s = await session({ decide: () => 'dont_send' });
    const id = ask(script([{ reply: { text: 'Use DB_PASSWORD=hunter2hunter2 for staging.' } }]));
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    await s.call('review_approvals');
    expect(s.elicited[0]).toContain('the secret screen found a secret-looking KEY=value pair');
    await sleep(500);
    expect(replyTo(id)).toBeUndefined();
    await waitFor(() => relay.toolEvents.some((e) => e.request_id === id && (e.body as { status: string }).status === 'error'), 5000, 'the cleared waiting');
  });

  it('request_approval makes the answer wait', async () => {
    const s = await session({ decide: () => 'send' });
    const id = ask(script([{ request_approval: 'not sure' }, { reply: { text: 'Probably Tuesday.' } }]));
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    await s.call('review_approvals');
    expect(s.elicited[0]).toContain(`the answerer asked for your approval (in the answerer's own words: "not sure")`);
    await waitFor(() => replyTo(id), 5000, 'the answer');
  });

  it('a capability call waits for the member before it runs; its result then waits too', async () => {
    const decisions = ['allow', 'send'];
    const s = await session({ decide: () => decisions.shift()!, env: { CAP_SERVICE_HEALTH_ENABLED: 'true', CAP_SERVICE_HEALTH_RUNNER: RUNNER } });
    expect((relay.manifests.get('bob') as { capabilities: Array<{ name: string }> }).capabilities.map((c) => c.name)).toEqual(['service_health']);
    const params = { service: 'api' };
    const id = relay.addRequest({ kind: 'capability', asker: 'alice', capability: { name: 'service_health', params }, recipients: { bob: { status: 'pending' } } });
    relay.enqueue('bob', 'inbox', { type: 'capability_call', from: 'alice', request_id: id, data: { capability: 'service_health', params, ack_deadline: iso(60_000), answer_deadline: iso(600_000) } });
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    expect(waitingNotes(s)[0]!.content).toContain('alice asked: "run service_health {"service":"api"}"');
    expect(relay.toolEvents.filter((e) => e.request_id === id).map((e) => e.body)).toEqual([{ tool: 'service_health', status: 'waiting', duration_ms: null }]);
    // Nothing ran yet.
    expect(relay.progress.filter((p) => p.request_id === id)).toEqual([]);
    const r = record(id);
    expect(Object.keys(r.mcp.mcpServers)).toEqual(['host', 'capabilities']);
    await s.call('review_approvals');
    expect(s.elicited[0]).toContain('alice asked you to run service_health with these params (teammate data):');
    expect(s.elicited[0]).toContain('wants to run service_health with {"service":"api"} for this capability call');
    await waitFor(() => waitingNotes(s).length === 2, 15_000, 'the draft notice');
    expect(relay.progress.filter((p) => p.request_id === id).length).toBeGreaterThan(0);
    expect(replyTo(id)).toBeUndefined();
    await s.call('review_approvals');
    await waitFor(() => replyTo(id), 5000, 'the answer');
    expect(replyTo(id)!.body).toMatchObject({ text: 'ran service_health', data: { capability: 'service_health', service: 'api', healthy: true } });
  });

  it('a question cannot run a capability, and credentials and other tools are denied without asking', async () => {
    const s = await session({ env: { CAP_SERVICE_HEALTH_ENABLED: 'true', CAP_SERVICE_HEALTH_RUNNER: RUNNER } });
    const id = ask(
      script([
        { capability: 'service_health' },
        { permission: { tool_name: 'Read', input: { file_path: join(process.env.HOME ?? '/home/u', '.ssh', 'id_ed25519') } } },
        { permission: { tool_name: 'Read', input: { file_path: join(proj, '.env') } } },
        { permission: { tool_name: 'Bash', input: { command: 'cat /etc/passwd' } } },
        { permission: { tool_name: 'mcp__host__permission', input: {} } },
      ]),
    );
    await waitFor(() => existsSync(join(tmp, 'stub-claude', `${id}.json`)) && record(id).calls.filter((c: any) => c.tool === 'permission').length === 5, 15_000, 'the denials');
    const denials = record(id).calls.filter((c: any) => c.tool === 'permission').map((c: any) => JSON.parse(c.text));
    expect(denials.map((d: any) => d.behavior)).toEqual(['deny', 'deny', 'deny', 'deny', 'deny']);
    expect(denials[0].message).toBe('Capabilities run only for a capability call, never for a question.');
    expect(denials[1].message).toMatch(/never readable/);
    expect(denials[2].message).toMatch(/never readable/);
    expect(denials[3].message).toBe('Bash is not available when answering automatically.');
    // The member was never asked about any of them: only the draft that followed waits.
    await waitFor(() => waitingNotes(s).length === 1, 5000, 'the draft notice');
    expect(relay.toolEvents.filter((e) => e.request_id === id).map((e) => e.body)).toEqual([{ tool: 'approval', status: 'waiting', duration_ms: null }]);
    expect(s.elicited).toHaveLength(0);
  });

  it('a lapse sends nothing: an approval nobody gives is denied at the deadline', async () => {
    const s = await session({ decide: null });
    const id = ask(script([{ permission: { tool_name: 'Read', input: { file_path: '/etc/hosts' } } }, { reply: { text: 'read: {{decision}}' } }]), 4000);
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    await waitFor(() => existsSync(join(tmp, 'stub-claude', `${id}.json`)) && record(id).calls.some((c: any) => c.tool === 'reply'), 15_000, 'the answerer to go on');
    const perm = record(id).calls.find((c: any) => c.tool === 'permission');
    expect(JSON.parse(perm.text)).toEqual({ behavior: 'deny', message: 'The member did not allow this in time. Answer without it, or say you could not.' });
    await sleep(1000);
    expect(replyTo(id)).toBeUndefined();
    expect((await s.call('whoami')).json).toMatchObject({ approvals_pending: 0 });
    expect(relay.toolEvents.filter((e) => e.request_id === id).map((e) => (e.body as { tool: string; status: string }).status)).toEqual(
      expect.arrayContaining(['waiting', 'error']),
    );
  });
});

describe('the read trail (M8-SPEC §7 item 1)', () => {
  it('an answer after reading an ordinary file in the folder ships on its own; the hook reported the read', async () => {
    const s = await session();
    const id = ask(script([{ read: { tool_name: 'Read', input: { file_path: join(proj, 'NOTES.md') } } }, { reply: { text: 'europe-west3' } }]));
    await waitFor(() => replyTo(id), 15_000, 'the answer');
    const r = record(id);
    const hook = r.calls.find((c: any) => c.hook);
    expect(hook).toMatchObject({ blocked: false, pre: [0] });
    expect(waitingNotes(s)).toHaveLength(0);
  });

  it('an answer after reading a file whose name suggests secrets waits, whatever the answerer says', async () => {
    writeFileSync(join(proj, 'secrets.yaml'), 'db: staging\n');
    const s = await session({ decide: () => 'dont_send' });
    const id = ask(script([{ read: { tool_name: 'Read', input: { file_path: join(proj, 'secrets.yaml') } } }, { reply: { text: 'The db is staging.' } }]));
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    expect(replyTo(id)).toBeUndefined();
    await s.call('review_approvals');
    expect(s.elicited[0]).toContain('it read files whose names suggest secrets (secrets.yaml)');
  });

  it('a search whose matches include such a file makes the answer wait too', async () => {
    const s = await session({ decide: () => 'dont_send' });
    const response = { mode: 'content', filenames: [], content: `${join(proj, 'infra', 'terraform.tfstate')}:12:  "password": "x"` };
    const id = ask(script([{ read: { tool_name: 'Grep', input: { pattern: 'password', path: proj }, response } }, { reply: { text: 'Nothing interesting.' } }]));
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    await s.call('review_approvals');
    expect(s.elicited[0]).toContain('it read files whose names suggest secrets (terraform.tfstate)');
    expect(replyTo(id)).toBeUndefined();
  });

  it('a search whose result was never reported makes the answer wait (the trail fails closed)', async () => {
    const s = await session({ decide: () => 'dont_send' });
    const id = ask(script([{ read: { tool_name: 'Grep', input: { pattern: 'x', path: proj }, skip_post: true } }, { reply: { text: 'Nothing.' } }]));
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    await s.call('review_approvals');
    expect(s.elicited[0]).toContain('what one of its searches read could not be recorded');
    expect(replyTo(id)).toBeUndefined();
  });

  it('a search that failed, or matched only ordinary files, does not hold the answer', async () => {
    await session();
    const id = ask(
      script([
        { read: { tool_name: 'Grep', input: { pattern: 'x', path: proj }, fail: true } },
        { read: { tool_name: 'Grep', input: { pattern: 'bucket', path: proj }, response: { mode: 'files_with_matches', filenames: [join(proj, 'NOTES.md')] } } },
        { reply: { text: 'In NOTES.md.' } },
      ]),
    );
    await waitFor(() => replyTo(id), 15_000, 'the answer');
  });
});

describe('what the member is asked (M8-SPEC §7 items 6, 7)', () => {
  it('a path that resolves elsewhere is shown with where it really leads', async () => {
    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'x.txt'), 'x\n');
    symlinkSync(join(outside, 'x.txt'), join(proj, 'link'));
    const s = await session({ decide: () => 'deny' });
    const id = ask(script([{ permission: { tool_name: 'Read', input: { file_path: join(proj, 'link') } } }, { reply: { text: 'no' } }]));
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    await s.call('review_approvals');
    expect(s.elicited[0]).toContain(`Your automatic answerer wants to read the file ${join(proj, 'link')} → ${join(outside, 'x.txt')}.`);
    await waitFor(() => record(id).calls.some((c: any) => c.tool === 'reply'), 15_000, 'the reply');
  });

  it('a Glob or Grep glob with a fixed prefix on the deny list is denied without asking', async () => {
    const home = process.env.HOME ?? '/home/u';
    const s = await session();
    const id = ask(
      script([
        { permission: { tool_name: 'Glob', input: { pattern: join(home, '.ssh', '*') } } },
        { permission: { tool_name: 'Glob', input: { pattern: '~/.aws/**' } } },
        { permission: { tool_name: 'Glob', input: { pattern: '.kube/*', path: home } } },
        { permission: { tool_name: 'Glob', input: { pattern: '/srv/app/**/*.pem' } } },
        { permission: { tool_name: 'Grep', input: { pattern: 'x', path: '/srv', glob: join(home, '.config', 'gcloud', '**') } } },
        { reply: { text: 'none' } },
      ]),
    );
    await waitFor(() => existsSync(join(tmp, 'stub-claude', `${id}.json`)) && record(id).calls.some((c: any) => c.tool === 'reply'), 15_000, 'the reply');
    const denials = record(id).calls.filter((c: any) => c.tool === 'permission').map((c: any) => JSON.parse(c.text));
    expect(denials.map((d: any) => d.behavior)).toEqual(['deny', 'deny', 'deny', 'deny', 'deny']);
    for (const d of denials) expect(d.message).toMatch(/never readable/);
    expect(s.elicited).toHaveLength(0);
  });
});

describe('taking over answering (M8-SPEC §7 item 4)', () => {
  it('is announced in the working session', async () => {
    const s = await session();
    await waitFor(() => s.notes.find((n) => n.content.includes('now answers teammates automatically')), 5000, 'the announcement');
    const note = s.notes.find((n) => n.content.includes('now answers teammates automatically'))!;
    expect(note.meta).toEqual({ type: 'status' });
    expect(note.content).toBe(`team-relay: This session now answers teammates automatically from ${proj}; reads inside it are automatic.`);
  });

  it('says so when reads are not automatic', async () => {
    const plain = join(tmp, 'plain');
    mkdirSync(plain);
    const s = await session({ cwd: plain });
    await waitFor(() => s.notes.find((n) => n.content.includes('now answers teammates automatically')), 5000, 'the announcement');
    expect(s.notes.find((n) => n.content.includes('now answers teammates automatically'))!.content).toMatch(
      /from .*\/plain; reads inside it are not automatic \(it is not inside a git work tree.*\): every read needs your approval\.$/,
    );
  });
});

describe('where the answerer may read (M8-SPEC §1)', () => {
  it('a folder that does not qualify: the answerer runs in an empty private directory and reads nothing without asking', async () => {
    const home = join(tmp, 'home');
    mkdirSync(home);
    await session({ cwd: home, env: { HOME: home } });
    const id = ask(script([{ reply: { text: 'nothing read' } }]));
    await waitFor(() => replyTo(id), 15_000, 'the answer');
    const r = record(id);
    expect(r.cwd).not.toBe(home);
    expect(r.cwd).toMatch(/\/trh-[^/]+\/run-[^/]+\/work$/);
    expect(r.settings.permissions.allow).toEqual(['mcp__host__reply', 'mcp__host__request_approval']);
    expect(r.stdin).not.toContain(home);
    // No folder is shared.
    expect(relay.manifests.get('bob')).toMatchObject({ shares: [] });
  });
});

describe('the fallback page (M8-SPEC §4)', () => {
  it('without elicitation, /team-relay:approvals opens the local page by way of the redirect file', async () => {
    const opened = join(tmp, 'opened.html');
    const opener = join(tmp, 'opener.sh');
    writeFileSync(opener, `#!/bin/sh\ncp "$1" "${opened}"\n`);
    chmodSync(opener, 0o700);
    const s = await session({ decide: null, env: { TEAM_RELAY_OPEN_COMMAND: opener } });
    const id = ask(script([{ reply: { text: 'maybe', needs_approval: true } }]));
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    const r = await s.call('review_approvals');
    expect(r.json.message).toMatch(/opened in your browser on a local page instead \(127\.0\.0\.1, with a one-time key\)/);
    // The key never reaches the model.
    expect(r.text).not.toMatch(/#k=/);
    await waitFor(() => existsSync(opened), 5000, 'the opener');
    const url = /url=([^"]+)"/.exec(readFileSync(opened, 'utf8'))![1]!;
    const { origin, hash } = new URL(url);
    const key = hash.slice(3);
    const list = (await (await fetch(`${origin}/api/approvals`, { headers: { 'X-Approvals-Key': key } })).json()) as { items: Array<{ id: string }> };
    expect(list.items).toHaveLength(1);
    const status = await new Promise<number>((resolve) => {
      const body = JSON.stringify({ decision: 'send' });
      const req = request(`${origin}/api/approvals/${list.items[0]!.id}`, {
        method: 'POST',
        headers: { 'X-Approvals-Key': key, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => resolve(res.statusCode ?? 0));
      req.end(body);
    });
    expect(status).toBe(200);
    await waitFor(() => replyTo(id), 5000, 'the answer');
    expect(replyTo(id)!.body.text).toBe('maybe');
  });
});

describe('one host per machine (M8-SPEC §1)', () => {
  it('a second channel session does not answer while the first holds the lock', async () => {
    const first = await session();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(DIST, 'channel.js')],
      cwd: proj,
      env: baseEnv({ RELAY_URL: relay.url, RELAY_TEAM: 'demo', RELAY_TOKEN: TOKEN_OF.bob!, RELAY_ROLE: 'asker', TEAM_RELAY_AUTO_ANSWER: '1', TEAM_RELAY_CLAUDE_BIN: STUB, TMPDIR: tmp, XDG_CONFIG_HOME: xdg }),
      stderr: 'pipe',
    });
    const second = new Client({ name: 'second', version: '0' }, { capabilities: {} });
    await second.connect(transport);
    try {
      await sleep(1000);
      const who = JSON.parse(textOf(await second.callTool({ name: 'whoami', arguments: {} })));
      expect(who.answering_automatically).toBe(false);
      expect(who.answering_note).toMatch(/^a channel working session on this computer \(pid \d+\) answers for you$/);
      expect((await first.call('whoami')).json.answering_automatically).toBe(true);
      const r = JSON.parse(textOf(await second.callTool({ name: 'review_approvals', arguments: {} })));
      expect(r.message).toMatch(/is not answering automatically/);
    } finally {
      await second.close();
    }
  });

  it('TEAM_RELAY_AUTO_ANSWER=0 keeps a channel session from answering', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(DIST, 'channel.js')],
      cwd: proj,
      env: baseEnv({ RELAY_URL: relay.url, RELAY_TEAM: 'demo', RELAY_TOKEN: TOKEN_OF.bob!, RELAY_ROLE: 'asker', TMPDIR: tmp, XDG_CONFIG_HOME: xdg }),
      stderr: 'pipe',
    });
    const c = new Client({ name: 'off', version: '0' }, { capabilities: {} });
    await c.connect(transport);
    try {
      ask('anyone?');
      await sleep(1500);
      expect(relay.requests.some((r) => r.path.endsWith('/streams/inbox'))).toBe(false);
      expect(relay.acks).toEqual([]);
    } finally {
      await c.close();
    }
  });
});

function sessionStart(): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [join(DIST, 'session-start.js')],
      { env: { PATH: process.env.PATH ?? '', XDG_CONFIG_HOME: xdg, TEAM_RELAY_CHANNEL: '1', RELAY_URL: relay.url, RELAY_TEAM: 'demo', RELAY_AUTH: 'token', RELAY_TOKEN: TOKEN_OF.bob! }, encoding: 'utf8', timeout: 10_000 },
      (_err, stdout) => resolve(stdout),
    );
    child.stdin?.end('{}');
  });
}
