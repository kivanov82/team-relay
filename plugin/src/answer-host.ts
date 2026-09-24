// The host (M8-SPEC §1–§5): the channel server of a channel working session answers the
// member's teammates on its own, within the folder the session works in.
//
// - It holds the machine's answering lock (answering-lock.ts); only then does it read the
//   `inbox` stream. Without the lock it retries every 30 s and answers nothing.
// - For each question or capability call: ack at the relay at once, then (one at a time) run
//   a locked-down headless Claude in the scope folder (headless.ts) that finishes with the
//   host's `reply` tool, over a private socket (host-socket.ts, answer-tools.ts).
// - What ships on its own and what waits for the member is decided here, deterministically
//   (§3): reads outside the folder and every capability tool wait (the permission tool); a
//   draft ships only when the answerer did not flag it, the secret screen passes it and no
//   approval was needed during the run. Everything else waits in the ApprovalQueue, which
//   only the member's dialog or page decides, and which denies on timeout.
// - The member is told in the working session (a status event), by a desktop notification
//   (fixed text), and the asker's console by a `waiting` tool event.
//
// Teammate text is data throughout: it reaches the answerer only inside a nonce-framed block
// of its prompt, and the working session only quoted and neutralised in a status event.

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActiveRequests, deadlineOf } from './active.js';
import { heldBy, lockPath, tryAcquire, type Acquired, type LockInfo } from './answering-lock.js';
import { ApprovalQueue, type ItemContext, type Pending } from './approvals.js';
import { ApprovalsPage } from './approvals-page.js';
import { reviewWithElicitation, summaryText, type Elicit } from './approvals-review.js';
import { approvalsSentence, clearApprovalsState, statePath, writeApprovalsState } from './approvals-state.js';
import { openInBrowser } from './console-open.js';
import { credentialHit, realOr, within } from './deny-list.js';
import { defaultManifestPath, discoveryPayload, exposedCapabilities } from './exposed.js';
import {
  buildPrompt,
  childArgs,
  childEnv,
  childMcpConfig,
  childSettings,
  rubric,
  runChild,
  RUN_LIMIT_MS,
  type WorkItem,
} from './headless.js';
import { HostSocket, newToken } from './host-socket.js';
import { codePointLength, hasLoneSurrogate, loadManifest, validateManifest } from './manifest.js';
import { envelopeToNotification, neutraliseChannelTags, RecentIds } from './notify.js';
import { APPROVAL_TEXT, notifyCommand } from './notify-desktop.js';
import { RelayError, type AuthMode, type Envelope, type Me, type RelayClient, backoffDelay } from './relay-client.js';
import { relayCredentialDirs, scopeFolder, type Scope } from './scope.js';
import { screenDraft } from './secret-screen.js';
import { splitToolName } from './tool-event-core.js';
import { canonicalJson, describeError, isPlainObject } from './tool-util.js';

export const POLITE_DECLINE = (member: string) => `I couldn't answer this automatically; ${member} hasn't approved it.`;
const REPLY_DATA_LIMIT = 64 * 1024;
const LOCK_RETRY_MS = 30_000;
const QUOTE_LIMIT = 200;

/** How the relay is reached, so the answerer's own servers can reach it the same way. */
export type HostConnection = {
  mode: AuthMode;
  url: string;
  team: string;
  credentialsFile?: string | undefined;
  tokenFile?: string | undefined;
  token?: string | undefined;
  gcloudAccount?: string | undefined;
};

export type HostOptions = {
  client: RelayClient;
  me: Me;
  env: NodeJS.ProcessEnv;
  connection: HostConnection;
  /** A status event into the working session. */
  push: (content: string) => Promise<void> | void;
  log: (line: string) => void;
  cwd?: string;
  /** Where the bundles are (dist/). */
  distDir?: string;
  node?: string;
  claudeBin?: string;
  lockFile?: string;
  stateFile?: string;
  lockRetryMs?: number;
  /** Desktop notification (fixed text); default: osascript / notify-send. */
  notify?: () => void;
  /** Opens the fallback page; default: the redirect-file opener. */
  openPage?: (url: string) => void;
};

export type HostStatus = {
  answering: boolean;
  why_not?: string;
  folder: string | null;
  reads_without_asking: boolean;
  approvals_pending: number;
};

function ownDist(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return basename(here) === 'src' ? join(here, '..', 'dist') : here;
}

function singleLine(text: string, limit: number): string {
  const flat = neutraliseChannelTags(text).replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

type Run = {
  item: WorkItem;
  replied: boolean;
  approvalNeeded: boolean;
  approvalRequested: string | null;
  waiting: number;
  cwd: string;
  denyDirs: string[];
};

export class AnswerHost {
  readonly queue = new ApprovalQueue();
  private readonly env: NodeJS.ProcessEnv;
  private readonly scope: Scope;
  private readonly dist: string;
  private readonly node: string;
  private readonly lockFile: string;
  private readonly stateFile: string;
  private readonly controller = new AbortController();
  private lock: Acquired | null = null;
  private holder: LockInfo | null = null;
  private socket: HostSocket | null = null;
  private page: ApprovalsPage | null = null;
  private work: WorkItem[] = [];
  private working = false;
  private current: Run | null = null;
  private reviewing = false;
  private claudeMissing = false;
  private readonly recent = new RecentIds(500);
  private whyNot: string | null = 'starting';

  constructor(private readonly o: HostOptions) {
    this.env = o.env;
    this.scope = scopeFolder(o.cwd ?? process.cwd(), o.env);
    this.dist = o.distDir ?? ownDist();
    this.node = o.node ?? process.execPath;
    this.lockFile = o.lockFile ?? lockPath(o.env);
    this.stateFile = o.stateFile ?? statePath(o.env);
    this.queue.onChange((e) => this.onQueueChange(e.type, e.item, e.outcome));
  }

  get stopped(): boolean {
    return this.controller.signal.aborted;
  }

  get folder(): Scope {
    return this.scope;
  }

  status(): HostStatus {
    return {
      answering: this.lock !== null && !this.stopped,
      ...(this.lock ? {} : { why_not: this.whyNot ?? 'not started' }),
      folder: this.scope.share,
      reads_without_asking: this.scope.qualifies,
      approvals_pending: this.queue.size,
    };
  }

  /** The whoami fields (M8-SPEC §5). */
  whoamiFields(): Record<string, unknown> {
    const s = this.status();
    const sentence = approvalsSentence(s.approvals_pending);
    return {
      answering_automatically: s.answering,
      ...(s.why_not ? { answering_note: s.why_not } : {}),
      answering_folder: s.folder,
      approvals_pending: s.approvals_pending,
      ...(sentence ? { approvals_notice: `${sentence}: run /team-relay:approvals` } : {}),
    };
  }

  // -- lifecycle ------------------------------------------------------------------------------

  /** Take the lock (retrying while another answerer holds it), then answer until stopped. */
  async start(): Promise<void> {
    const retry = this.o.lockRetryMs ?? LOCK_RETRY_MS;
    if (!this.scope.qualifies) {
      this.o.log(`the working folder cannot be read automatically (${this.scope.reason}): every read will need your approval`);
    }
    while (!this.stopped) {
      let got;
      try {
        got = tryAcquire(this.lockFile, 'host');
      } catch (err) {
        this.whyNot = `the answering lock could not be taken (${describeError(err)})`;
        this.o.log(this.whyNot);
        await this.sleep(retry);
        continue;
      }
      if (got.ok) {
        this.lock = got;
        this.whyNot = null;
        break;
      }
      if (this.holder?.pid !== got.holder?.pid) this.o.log(`not answering: ${heldBy(got.holder)} answers for you`);
      this.holder = got.holder;
      this.whyNot = `${heldBy(got.holder)} answers for you`;
      await this.sleep(retry);
    }
    if (this.stopped) return;
    try {
      this.socket = new HostSocket();
      await this.socket.listen();
    } catch (err) {
      this.o.log(`cannot answer automatically: the private socket could not be made (${describeError(err)})`);
      this.whyNot = 'the private socket could not be made';
      this.lock?.release();
      this.lock = null;
      return;
    }
    this.writeState();
    await this.publish(this.scope.qualifies && this.scope.share ? [this.scope.share] : []);
    this.o.log(`answering automatically in ${this.scope.path}${this.scope.qualifies ? '' : ' (no automatic reads)'}`);
    await this.inboxLoop();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.controller.abort();
    this.queue.cancelAll();
    await this.page?.stop().catch(() => {});
    this.page = null;
    await this.socket?.close().catch(() => {});
    this.socket = null;
    try {
      clearApprovalsState(this.stateFile);
    } catch {
      // nothing to clear
    }
    this.lock?.release();
    this.lock = null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) return resolve();
      const t = setTimeout(done, ms);
      const signal = this.controller.signal;
      function done() {
        clearTimeout(t);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done);
    });
  }

  /** M4-SPEC §3 / M8-SPEC §1: the capabilities this member runs, and the folder it shares. */
  private async publish(shares: string[]): Promise<void> {
    try {
      const manifest = loadManifest(this.env.MANIFEST_PATH || defaultManifestPath());
      const { exposed } = exposedCapabilities(manifest, this.env);
      const payload = validateManifest(discoveryPayload(exposed, shares.map((name) => ({ name }))));
      const res = await this.o.client.publishManifest(this.o.me.member, payload, { attempts: 2, signal: this.controller.signal });
      this.o.log(`published capabilities: ${res.capabilities.join(', ') || '(none)'}; shared folder: ${shares.join(', ') || '(none)'}`);
    } catch (err) {
      if (!this.stopped) this.o.log(`the capability manifest was not published (${describeError(err)})`);
    }
  }

  // -- the inbox --------------------------------------------------------------------------------

  private async inboxLoop(): Promise<void> {
    let failures = 0;
    const { client } = this.o;
    while (!this.stopped) {
      const started = Date.now();
      try {
        const page = await client.readStream('inbox', { wait: 25, limit: 50 }, { attempts: 1, signal: this.controller.signal });
        failures = 0;
        for (const envelope of page.messages) {
          if (this.stopped) return;
          await this.accept(envelope);
          await client.ackCursor('inbox', envelope.seq, { attempts: 1, signal: this.controller.signal });
        }
        if (page.messages.length === 0 && Date.now() - started < 1000) await this.sleep(1000);
      } catch (err) {
        if (this.stopped) return;
        if (err instanceof RelayError && err.status === 401) {
          this.o.log('the relay refused the sign-in while reading the inbox; answering stops until you sign in again');
          return;
        }
        const delay = backoffDelay(failures++);
        this.o.log(`inbox read failed (${describeError(err)}); retrying in ${Math.round(delay / 1000)} s`);
        await this.sleep(delay);
      }
    }
  }

  /** One inbox envelope: acknowledged at the relay at once, then queued for an answerer. */
  private async accept(envelope: Envelope): Promise<void> {
    const { client, me } = this.o;
    if (this.recent.has(envelope.id)) return;
    const n = envelopeToNotification(envelope, { stream: 'inbox', team: me.team, member: me.member });
    if ('reject' in n) {
      this.o.log(`skipped inbox seq ${String(envelope.seq)}: ${n.reject}`);
      return;
    }
    let ack: Record<string, unknown>;
    try {
      ack = (await client.ackRequest(envelope.request_id, { attempts: 2, signal: this.controller.signal })) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof RelayError && [404, 409, 410].includes(err.status)) {
        this.recent.add(envelope.id);
        this.o.log(`${envelope.request_id} can no longer be answered (${err.status}); skipped`);
        return;
      }
      throw err;
    }
    this.recent.add(envelope.id);
    if (ack.status === 'answered') return;
    const data = envelope.data ?? {};
    const deadline =
      deadlineOf(ack.answer_deadline) ?? deadlineOf(data.answer_deadline) ?? new Date(Date.now() + 86_400_000).toISOString();
    const item: WorkItem = {
      request_id: envelope.request_id,
      from: envelope.from,
      kind: envelope.type === 'capability_call' ? 'capability_call' : 'question',
      question: typeof data.question === 'string' ? data.question : '',
      answer_deadline: Date.parse(deadline),
      ...(envelope.type === 'capability_call'
        ? { capability: { name: String(data.capability), params: isPlainObject(data.params) ? data.params : {} } }
        : {}),
    };
    this.work.push(item);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (!this.stopped) {
        const item = this.work.shift();
        if (!item) break;
        if (Date.now() >= item.answer_deadline) {
          this.o.log(`${item.request_id} passed its answer deadline before it could be answered`);
          continue;
        }
        try {
          await this.answer(item);
        } catch (err) {
          this.o.log(`answering ${item.request_id} failed: ${describeError(err)}`);
        }
      }
    } finally {
      this.working = false;
    }
  }

  // -- one answerer run -------------------------------------------------------------------------

  private claudeBin(): string {
    const b = (this.o.claudeBin ?? this.env.TEAM_RELAY_CLAUDE_BIN ?? '').trim();
    return b && isAbsolute(b) ? b : 'claude';
  }

  private async answer(item: WorkItem): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    const runDir = mkdtempSync(join(socket.dir, 'run-'));
    let plan: RunPlan;
    try {
      plan = planRun({
        item,
        runDir,
        socket: { path: socket.path, dir: socket.dir },
        scope: this.scope,
        env: this.env,
        connection: this.o.connection,
        member: this.o.me.member,
        dist: this.dist,
        node: this.node,
        claudeBin: this.claudeBin(),
        log: this.o.log,
      });
    } catch (err) {
      rmSync(runDir, { recursive: true, force: true });
      throw err;
    }
    const active = new ActiveRequests(plan.stateDir, (err) => this.o.log(`open request not recorded: ${describeError(err)}`));
    await active.add(item.request_id, new Date(item.answer_deadline).toISOString());

    const run: Run = { item, replied: false, approvalNeeded: false, approvalRequested: null, waiting: 0, cwd: plan.cwd, denyDirs: plan.denyDirs };
    this.current = run;
    socket.setRun(plan.token, (method, params) => this.onCall(run, method, params));
    try {
      const result = await runChild({
        bin: plan.bin,
        args: plan.args,
        cwd: plan.cwd,
        env: plan.env,
        stdin: plan.stdin,
        limitMs: RUN_LIMIT_MS,
        hardDeadline: item.answer_deadline + 60_000,
        paused: () => run.waiting > 0,
        signal: this.controller.signal,
      });
      if (result.code === null && result.signal === null && !result.timedOut && !this.claudeMissing) {
        this.claudeMissing = true;
        this.o.log(`could not start ${plan.bin} (is Claude Code on PATH?); set TEAM_RELAY_CLAUDE_BIN to its absolute path`);
      }
      if (!run.replied && !this.stopped) {
        const why = result.timedOut
          ? 'it ran out of time'
          : result.result?.is_error
            ? `it failed (${String(result.result.subtype ?? 'error')})`
            : `it ended without replying (exit ${result.code ?? result.signal})`;
        this.o.log(`no answer sent for ${item.request_id}: ${why}`);
      }
    } finally {
      socket.clearRun();
      this.current = null;
      // Whatever the run still waited for is withdrawn: it can no longer be used.
      this.queue.cancelWhere((p) => p.ctx.request_id === item.request_id && p.ask.type === 'permission');
      rmSync(runDir, { recursive: true, force: true });
    }
  }

  private ctxOf(item: WorkItem): ItemContext {
    return {
      request_id: item.request_id,
      asker: item.from,
      kind: item.kind,
      question: item.question,
      ...(item.capability ? { capability: item.capability } : {}),
    };
  }

  private async onCall(run: Run, method: string, params: unknown): Promise<unknown> {
    if (this.current !== run) throw new Error('this answer is over');
    const p = isPlainObject(params) ? params : {};
    if (method === 'reply') return this.onReply(run, p);
    if (method === 'request_approval') {
      const reason = typeof p.reason === 'string' ? p.reason.slice(0, 500) : 'no reason given';
      run.approvalRequested = reason;
      return { ok: true, message: "Noted: your answer will wait for the member's approval before it is sent." };
    }
    if (method === 'permission') return this.onPermission(run, p);
    throw new Error(`unknown method: ${method}`);
  }

  // -- §3: the reply decision table ---------------------------------------------------------

  private async onReply(run: Run, p: Record<string, unknown>): Promise<unknown> {
    if (run.replied) return { ok: false, message: 'You have already replied; reply only once.' };
    const text = p.text;
    if (typeof text !== 'string' || text.length === 0 || codePointLength(text) > 32000) return { ok: false, message: 'text must be 1 to 32000 characters' };
    if (hasLoneSurrogate(text)) return { ok: false, message: 'text contains a lone surrogate' };
    let data: Record<string, unknown> | null = null;
    if (p.data !== undefined && p.data !== null) {
      if (!isPlainObject(p.data)) return { ok: false, message: 'data must be a JSON object' };
      if (Buffer.byteLength(JSON.stringify(p.data), 'utf8') > REPLY_DATA_LIMIT) return { ok: false, message: 'data is larger than 64 KiB' };
      data = p.data;
    }
    if (p.needs_approval !== undefined && typeof p.needs_approval !== 'boolean') return { ok: false, message: 'needs_approval must be true or false' };
    const reasons = draftReasons({
      needsApproval: p.needs_approval === true,
      reason: typeof p.reason === 'string' ? p.reason : null,
      requested: run.approvalRequested,
      approvalDuringRun: run.approvalNeeded,
      text,
      data,
    });
    run.replied = true;
    if (reasons.length === 0) {
      try {
        await this.sendReply(run.item.request_id, text, data);
      } catch (err) {
        run.replied = false;
        return { ok: false, message: `the answer could not be sent (${describeError(err)})` };
      }
      this.o.log(`answered ${run.item.request_id} automatically`);
      return { ok: true, message: 'Sent.' };
    }
    const { outcome } = this.queue.add(this.ctxOf(run.item), { type: 'draft', text, data, reasons }, run.item.answer_deadline);
    void outcome.then((o) => this.settleDraft(run.item, text, data, o));
    return { ok: true, message: "Your answer waits for the member's approval. Nothing more to do: end here." };
  }

  private async sendReply(requestId: string, text: string, data: Record<string, unknown> | null): Promise<void> {
    await this.o.client.reply(requestId, { idempotency_key: randomUUID(), text, data });
  }

  private async settleDraft(item: WorkItem, text: string, data: Record<string, unknown> | null, outcome: string): Promise<void> {
    try {
      if (outcome === 'send') {
        await this.sendReply(item.request_id, text, data);
        this.o.log(`sent the approved answer to ${item.request_id}`);
      } else if (outcome === 'decline') {
        await this.sendReply(item.request_id, POLITE_DECLINE(this.o.me.member), null);
        this.o.log(`declined ${item.request_id} politely`);
      } else {
        this.o.log(`nothing sent for ${item.request_id} (${outcome})`);
      }
    } catch (err) {
      this.o.log(`the answer to ${item.request_id} could not be sent (${describeError(err)})`);
    }
    this.toolEvent(item.request_id, 'approval', outcome === 'send' ? 'ok' : 'error');
  }

  // -- §3: the permission tool --------------------------------------------------------------

  private async onPermission(run: Run, p: Record<string, unknown>): Promise<{ allow: boolean; message?: string }> {
    // Anything outside the allow list makes the draft wait too, whatever is decided here.
    run.approvalNeeded = true;
    const toolName = typeof p.tool_name === 'string' ? p.tool_name : '';
    const input = isPlainObject(p.input) ? p.input : {};
    const ask = this.classify(run, toolName, input);
    if ('deny' in ask) {
      this.o.log(`denied ${toolName || 'a tool'} for ${run.item.request_id} without asking: ${ask.deny}`);
      return { allow: false, message: ask.deny };
    }
    const { outcome } = this.queue.add(this.ctxOf(run.item), { type: 'permission', tool: ask.tool, action: ask.action }, run.item.answer_deadline);
    run.waiting++;
    let result: string;
    try {
      result = await outcome;
    } finally {
      run.waiting--;
    }
    if (result === 'allow') return { allow: true };
    this.toolEvent(run.item.request_id, ask.tool, 'error');
    const message =
      result === 'deny'
        ? 'The member denied this. Answer without it, or say you could not.'
        : 'The member did not allow this in time. Answer without it, or say you could not.';
    return { allow: false, message };
  }

  /** What the member is asked, or why it is denied without asking. */
  private classify(run: Run, toolName: string, input: Record<string, unknown>): { tool: string; action: string } | { deny: string } {
    const { server, tool } = splitToolName(toolName);
    if (server === null && (tool === 'Read' || tool === 'Glob' || tool === 'Grep')) {
      const raw = tool === 'Read' ? input.file_path : input.path;
      const given = typeof raw === 'string' && raw ? raw : run.cwd;
      const path = resolvePath(run.cwd, given);
      const real = realOr(path);
      const ctx = { home: this.env.HOME ?? '', credentialDirs: relayCredentialDirs(this.env) };
      if (credentialHit(path, ctx) || credentialHit(real, ctx) || run.denyDirs.some((d) => within(real, realOr(d)) || within(path, d))) {
        return { deny: 'That path is never readable (credentials and configuration are off limits). Do not try to reach it another way.' };
      }
      const pattern = typeof input.pattern === 'string' ? singleLine(input.pattern, 200) : '';
      if (tool === 'Read') return { tool, action: `read the file ${path}` };
      if (tool === 'Glob') return { tool, action: `list the files matching ${JSON.stringify(pattern)} in ${path}` };
      return { tool, action: `search ${path} for ${JSON.stringify(pattern)}` };
    }
    if (server === 'capabilities') {
      const item = run.item;
      if (item.kind !== 'capability_call' || !item.capability) {
        return { deny: 'Capabilities run only for a capability call, never for a question.' };
      }
      if (item.capability.name !== tool) return { deny: `This request is for ${item.capability.name}, not ${tool}.` };
      const { request_id: requestId, ...params } = input;
      if (requestId !== item.request_id) return { deny: `Use request_id "${item.request_id}".` };
      if (canonicalJson(params) !== canonicalJson(item.capability.params)) {
        return { deny: 'Use exactly the params of the capability call.' };
      }
      return { tool, action: `run ${tool} with ${JSON.stringify(item.capability.params)} for this capability call` };
    }
    return { deny: `${toolName || 'That tool'} is not available when answering automatically.` };
  }

  // -- telling the member and the asker -----------------------------------------------------

  private onQueueChange(type: 'added' | 'settled', item: Pending, _outcome?: string) {
    this.writeState();
    if (type !== 'added' || this.stopped) return;
    const n = this.queue.size;
    const quoted =
      item.ctx.kind === 'capability_call' && item.ctx.capability
        ? `run ${item.ctx.capability.name} ${singleLine(JSON.stringify(item.ctx.capability.params), QUOTE_LIMIT)}`
        : singleLine(item.ctx.question, QUOTE_LIMIT);
    void Promise.resolve(
      this.o.push(`team-relay: ${item.ctx.asker} asked: "${quoted}" — an answer is waiting for your approval (${n} pending). Run /team-relay:approvals.`),
    ).catch(() => {});
    this.toolEvent(item.ctx.request_id, item.ask.type === 'permission' ? item.ask.tool : 'approval', 'waiting');
    try {
      (this.o.notify ?? defaultNotify)();
    } catch {
      // a notification is a side surface
    }
  }

  private toolEvent(requestId: string, tool: string, status: 'ok' | 'error' | 'waiting') {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(tool)) return;
    void this.o.client.toolEvent(requestId, { tool, status, duration_ms: null }, { attempts: 1, timeoutMs: 5000 }).catch((err: unknown) => {
      this.o.log(`tool event for ${requestId} not recorded (${describeError(err)})`);
    });
  }

  private writeState() {
    if (!this.lock) return;
    try {
      writeApprovalsState(this.stateFile, this.queue.size);
    } catch (err) {
      this.o.log(`approvals count not written (${describeError(err)})`);
    }
  }

  // -- §4: the review ---------------------------------------------------------------------------

  /**
   * /team-relay:approvals. With elicitation, one dialog per item in the working session;
   * without it, the local page in the browser. Returns what the model may tell the member:
   * counts only.
   */
  async review(elicit: Elicit | null): Promise<string> {
    if (!this.lock) return `This session is not answering automatically (${this.whyNot ?? 'not started'}), so it holds no approvals.`;
    if (this.queue.size === 0) return 'Nothing is waiting for your approval.';
    if (this.reviewing) return 'A review is already open in this session: finish that one first.';
    this.reviewing = true;
    try {
      if (elicit) return summaryText(await reviewWithElicitation(this.queue, elicit, this.o.me.member));
      this.page ??= new ApprovalsPage(this.queue, this.o.me.member);
      const url = await this.page.start();
      (this.o.openPage ?? ((u: string) => openInBrowser(u, { log: this.o.log, title: 'Team relay approvals', what: 'the approvals page' })))(url);
      return (
        `This Claude Code does not offer dialogs to plugins (MCP elicitation), so your ${this.queue.size} pending approval(s) opened in your browser ` +
        'on a local page instead (127.0.0.1, with a one-time key). Decide there; nothing is sent or run before you do.'
      );
    } finally {
      this.reviewing = false;
    }
  }
}

export type RunPlan = {
  runDir: string;
  stateDir: string;
  /** The answerer's working directory: the scope folder when it qualifies, else an empty private one. */
  cwd: string;
  denyDirs: string[];
  token: string;
  bin: string;
  args: string[];
  env: Record<string, string>;
  stdin: string;
  files: { mcpConfig: string; settings: string; toolEvent: string | null };
};

/** How the answerer's servers reach the relay, and what they must never read. */
function relayServerEnv(
  connection: HostConnection,
  env: NodeJS.ProcessEnv,
  runDir: string,
): { env: Record<string, string>; denyFiles: string[]; toolEvent: Record<string, unknown> | null } {
  const c = connection;
  const out: Record<string, string> = { RELAY_URL: c.url, RELAY_TEAM: c.team, RELAY_AUTH: c.mode };
  const denyFiles: string[] = [];
  const toolEvent: Record<string, unknown> = { relay_url: c.url, relay_team: c.team, relay_auth: c.mode, state_dir: join(runDir, 'state') };
  if (c.mode === 'credential' && c.credentialsFile) {
    out.RELAY_CREDENTIALS_FILE = c.credentialsFile;
    toolEvent.credentials_file = c.credentialsFile;
    denyFiles.push(c.credentialsFile);
  } else if (c.mode === 'token') {
    let file = c.tokenFile;
    if (!file && c.token) {
      // Handed over as a file (mode 600, in the run's private directory), never in mcp.json.
      file = join(runDir, 'token');
      writeFileSync(file, `${c.token}\n`, { mode: 0o600, flag: 'wx' });
    }
    if (file) {
      out.RELAY_TOKEN_FILE = file;
      toolEvent.token_file = file;
      denyFiles.push(file);
    }
  } else if (c.mode === 'google') {
    if (c.gcloudAccount) {
      out.RELAY_GCLOUD_ACCOUNT = c.gcloudAccount;
      toolEvent.gcloud_account = c.gcloudAccount;
    }
    if (env.PATH) out.PATH = env.PATH;
    for (const [k, v] of Object.entries(env)) if (/^CLOUDSDK_[A-Z0-9_]+$/.test(k) && typeof v === 'string') out[k] = v;
  }
  return { env: out, denyFiles, toolEvent: c.mode === 'metadata' ? null : toolEvent };
}

/**
 * Everything one answerer run needs, written into `runDir` (a fresh mode-700 directory inside
 * the host's private directory): mcp.json, settings.json, tool-event.json (all mode 600), and
 * the command line, environment and prompt.
 */
export function planRun(p: {
  item: WorkItem;
  runDir: string;
  socket: { path: string; dir: string };
  scope: Scope;
  env: NodeJS.ProcessEnv;
  connection: HostConnection;
  member: string;
  dist: string;
  node: string;
  claudeBin: string;
  log?: (line: string) => void;
  token?: string;
}): RunPlan {
  const { runDir, env, scope } = p;
  const stateDir = join(runDir, 'state');
  mkdirSync(stateDir, { mode: 0o700 });
  const relay = relayServerEnv(p.connection, env, runDir);
  let cwd = scope.path;
  if (!scope.qualifies) {
    cwd = join(runDir, 'work');
    mkdirSync(cwd, { mode: 0o700 });
  }
  const denyDirs = [p.socket.dir, ...relayCredentialDirs(env)];
  const cloudsdk = env.CLOUDSDK_CONFIG?.trim();
  if (p.connection.mode === 'google' && cloudsdk && isAbsolute(cloudsdk)) denyDirs.push(cloudsdk);
  const claudeConfig = env.CLAUDE_CONFIG_DIR?.trim();
  if (claudeConfig && isAbsolute(claudeConfig)) denyDirs.push(claudeConfig);

  // The capability server, when the member offers any (the same rules as bin/answerer).
  let capabilities: { script: string; env: Record<string, string> } | null = null;
  try {
    const manifestPath = env.MANIFEST_PATH || defaultManifestPath();
    const { exposed } = exposedCapabilities(loadManifest(manifestPath), env);
    if (exposed.length > 0) {
      const capEnv: Record<string, string> = {
        ...relay.env,
        MANIFEST_PATH: manifestPath,
        ALLOW_PRODUCTION: env.ALLOW_PRODUCTION === 'true' ? 'true' : 'false',
      };
      for (const [k, v] of Object.entries(env)) {
        if (/^CAP_[A-Z][A-Z0-9_]*_(ENABLED|RUNNER)$/.test(k) && typeof v === 'string') capEnv[k] = v;
      }
      capabilities = { script: join(p.dist, 'capabilities.js'), env: capEnv };
    }
  } catch (err) {
    p.log?.(`capabilities not offered to this answer (${describeError(err)})`);
  }

  const token = p.token ?? newToken();
  const mcpConfig = join(runDir, 'mcp.json');
  const settings = join(runDir, 'settings.json');
  const toolEventFile = relay.toolEvent ? join(runDir, 'tool-event.json') : null;
  const write = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  write(mcpConfig, childMcpConfig({ node: p.node, answerTools: join(p.dist, 'answer-tools.js'), socket: p.socket.path, token, capabilities }));
  if (toolEventFile) write(toolEventFile, relay.toolEvent);
  write(
    settings,
    childSettings({
      scope,
      denyFiles: relay.denyFiles,
      denyDirs,
      ...(toolEventFile ? { toolEventHook: { node: p.node, script: join(p.dist, 'tool-event.js'), config: toolEventFile } } : {}),
    }),
  );
  const model = env.TEAM_RELAY_ANSWER_MODEL?.trim() || undefined;
  return {
    runDir,
    stateDir,
    cwd,
    denyDirs,
    token,
    bin: p.claudeBin,
    args: childArgs({ mcpConfig, settings }, rubric(p.member, scope), model),
    env: childEnv(env),
    stdin: buildPrompt(p.item),
    files: { mcpConfig, settings, toolEvent: toolEventFile },
  };
}

/** §3: why a draft waits (empty: it ships on its own). */
export function draftReasons(d: {
  needsApproval: boolean;
  reason: string | null;
  requested: string | null;
  approvalDuringRun: boolean;
  text: string;
  data: Record<string, unknown> | null;
}): string[] {
  const reasons: string[] = [];
  if (d.needsApproval) reasons.push(`the answerer flagged it${d.reason ? ` ("${singleLine(d.reason, 200)}")` : ''}`);
  if (d.requested !== null) reasons.push(`the answerer asked for your approval ("${singleLine(d.requested, 200)}")`);
  const secrets = screenDraft(d.text, d.data);
  if (secrets.length) reasons.push(`the secret screen found ${secrets.map((s) => s.kind).join(', ')}`);
  if (d.approvalDuringRun) reasons.push('it needed your permission for a step while it worked');
  return reasons;
}

function defaultNotify(): void {
  const cmd = notifyCommand(process.platform, APPROVAL_TEXT);
  if (!cmd) return;
  execFile(cmd.file, cmd.args, { timeout: 3000, windowsHide: true }, () => {});
}
