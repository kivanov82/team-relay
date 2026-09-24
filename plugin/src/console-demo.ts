// The console's --demo backend (M2-SPEC §4.4): a synthetic team `demo` (alice, bob, carol)
// with a scripted, looping stream of activity, served in exactly the shapes the relay serves
// (§3.1, §3.5, §3.6 of M2-SPEC; §3.2, §3.4, §3.11 of M1-SPEC) and by the relay's rules
// (§7 of M2-SPEC): `updated_at` strictly increasing per request, feed pages that never split
// a group of requests with the same `updated_at`, `stats_complete` on the directory, `open`
// by effective status, `answered` by `answered_at` in the window, the median to 3 decimals,
// and answer previews masked as the relay masks them. The viewer is alice.
//
// Every cycle (60 s) starts seven requests: a directed question, a capability call with
// progress and a tool event, a broadcast that one teammate never acknowledges (no_response),
// a question between two teammates (alice is not a participant, so its text is masked), an
// acknowledged question that is never answered (timed_out), a capability call between two
// teammates, and a broadcast both recipients answer (alice sees only her own answer). The
// last is created in the same millisecond the capability call before it changes, so the
// feed has an equal-`updated_at` group to keep whole. Deadlines are applied the way the
// relay's sweep applies them, a moment after they pass, so a stored `pending` or `acked` past
// its deadline shows for that moment, as it can on the relay. A request's state at any moment
// is computed from its script, so the feed is consistent however often it is polled. All names
// and text are synthetic.

import { createHash } from 'node:crypto';
import { defaultManifestPath } from './exposed.js';
import { loadManifest, type Capability, type Manifest } from './manifest.js';

export const DEMO_TEAM = 'demo';
export const DEMO_ME = 'alice';
export const DEMO_MEMBERS = ['alice', 'bob', 'carol'] as const;
export const DEMO_CYCLE_MS = 60_000;
/** History present at start-up, so the console is not empty on its first poll. */
const WARMUP_CYCLES = 10;
const DAY_MS = 86_400_000;
/**
 * Demo requests are created with ttl_seconds 3600 (valid: at least the answer timeout), so
 * the feed, which serves unexpired requests only, holds about an hour of history.
 */
const DEMO_TTL_MS = 3_600_000;
const PREVIEW_CHARS = 2000;
/** How long after a deadline the (simulated) sweep records no_response or timed_out. */
export const SWEEP_LAG_MS = 2000;
/** The relay's limits (M2-SPEC §3.6, §7.10): one stats read, one equal-updated_at group. */
const STATS_READ_CAP = 500;
const ACTIVITY_MAX_GROUP = 500;

type Member = (typeof DEMO_MEMBERS)[number];
type Status = 'pending' | 'acked' | 'answered' | 'no_response' | 'timed_out';

export type ToolUse = { tool: string; status: 'ok' | 'error'; at: string; duration_ms: number | null };
export type RecipientView = {
  status: Status;
  delivered_at: string | null;
  acked_at: string | null;
  answered_at: string | null;
  answer_delivered_at: string | null;
  tools: ToolUse[];
  progress_count: number;
  last_progress_pct: number | null;
  answer_preview: string | null;
};
export type ActivityRequest = {
  request_id: string;
  kind: 'question' | 'capability';
  asker: string;
  broadcast: boolean;
  created_at: string;
  updated_at: string;
  ack_deadline: string;
  answer_deadline: string;
  expire_at: string;
  capability: { name: string; environment: string; params: Record<string, unknown> | null } | null;
  question: string | null;
  recipients: Record<string, RecipientView>;
  participant: boolean;
};
type ProgressItem =
  | { seq: number; member: string; kind: 'progress'; text: string; pct: number | null; time: string }
  | { seq: number; member: string; kind: 'tool'; tool: string; status: 'ok' | 'error'; duration_ms: number | null; time: string };

// ---------------------------------------------------------------------------------------
// Scripts: offsets in ms from the request's creation.

type Step =
  | { at: number; to: Member; do: 'deliver' | 'ack' | 'answer_delivered' }
  | { at: number; to: Member; do: 'answer'; text: string }
  | { at: number; to: Member; do: 'tool'; tool: string; status: 'ok' | 'error'; duration_ms: number }
  | { at: number; to: Member; do: 'progress'; text: string; pct: number };

type Script = {
  offset: number;
  kind: 'question' | 'capability';
  asker: Member;
  to: Member[];
  broadcast: boolean;
  question?: string;
  capability?: { name: string; params: Record<string, unknown> };
  ackTimeout: number;
  answerTimeout: number;
  steps: Step[];
};

const QUESTIONS_TO_BOB = [
  'Which service owns the nightly invoice export, and where is its retry policy configured?',
  'Is the orders table still partitioned by month in staging, or did that change with the last migration?',
  'What is the current timeout for calls from the web app to the pricing service?',
];
const ANSWERS_FROM_BOB = [
  'The invoice export lives in the worker service (jobs/export_invoices). Retries are set in its job config: three attempts, exponential backoff starting at 30 s.',
  'Still monthly. The last migration only added an index on status; partitioning is unchanged.',
  'Eight seconds, set in the web app client config, with one retry on a connection error only.',
];
const SECOND_FACTS = [
  'Does anyone know whether the feature flag for the new checkout is on in staging?',
  'Who changed the staging rate limits this week, and why?',
  'Is there a runbook for rotating the staging database password?',
];

function scripts(cycle: number): Script[] {
  const v = cycle % 3;
  return [
    {
      offset: 0,
      kind: 'question',
      asker: 'alice',
      to: ['bob'],
      broadcast: false,
      question: QUESTIONS_TO_BOB[v]!,
      ackTimeout: 120,
      answerTimeout: 1800,
      steps: [
        { at: 800, to: 'bob', do: 'deliver' },
        { at: 2500, to: 'bob', do: 'ack' },
        { at: 4000, to: 'bob', do: 'tool', tool: 'Grep', status: 'ok', duration_ms: 31 + v * 7 },
        { at: 5200, to: 'bob', do: 'tool', tool: 'Read', status: 'ok', duration_ms: 12 + v * 3 },
        { at: 9000, to: 'bob', do: 'answer', text: ANSWERS_FROM_BOB[v]! },
        { at: 10_100, to: 'bob', do: 'answer_delivered' },
      ],
    },
    {
      offset: 6000,
      kind: 'capability',
      asker: 'alice',
      to: ['bob'],
      broadcast: false,
      capability: {
        name: 'staging_db_query',
        params: { dataset: 'orders', field: 'status', op: 'eq', value: ['pending', 'failed', 'shipped'][v]!, limit: 20 },
      },
      ackTimeout: 120,
      answerTimeout: 1800,
      steps: [
        { at: 900, to: 'bob', do: 'deliver' },
        { at: 2800, to: 'bob', do: 'ack' },
        { at: 4000, to: 'bob', do: 'progress', text: 'connecting to the staging database', pct: 10 },
        { at: 6200, to: 'bob', do: 'progress', text: 'reading rows', pct: 60 },
        { at: 8500, to: 'bob', do: 'tool', tool: 'staging_db_query', status: 'ok', duration_ms: 4100 + v * 250 },
        { at: 11_000, to: 'bob', do: 'answer', text: `Found ${3 + v} orders with that status in staging; rows are in the data.` },
        { at: 12_000, to: 'bob', do: 'answer_delivered' },
      ],
    },
    {
      offset: 15_000,
      kind: 'question',
      asker: 'bob',
      to: ['alice', 'carol'],
      broadcast: true,
      question: 'Is anyone else seeing slow builds on the shared runner this afternoon?',
      ackTimeout: 20,
      answerTimeout: 600,
      steps: [
        { at: 1000, to: 'alice', do: 'deliver' },
        { at: 1600, to: 'carol', do: 'deliver' },
        { at: 3000, to: 'alice', do: 'ack' },
        { at: 4500, to: 'alice', do: 'tool', tool: 'Read', status: 'ok', duration_ms: 9 },
        { at: 10_000, to: 'alice', do: 'answer', text: 'Yes, since about two o\'clock: the cache volume is nearly full, so every build restores from scratch.' },
        { at: 11_000, to: 'alice', do: 'answer_delivered' },
      ],
    },
    {
      offset: 25_000,
      kind: 'question',
      asker: 'carol',
      to: ['bob'],
      broadcast: false,
      question: SECOND_FACTS[v]!,
      ackTimeout: 120,
      answerTimeout: 1800,
      steps: [
        { at: 700, to: 'bob', do: 'deliver' },
        { at: 2000, to: 'bob', do: 'ack' },
        { at: 3300, to: 'bob', do: 'tool', tool: 'Glob', status: 'ok', duration_ms: 18 },
        { at: 4100, to: 'bob', do: 'tool', tool: 'Read', status: 'error', duration_ms: 4 },
        { at: 5000, to: 'bob', do: 'tool', tool: 'Read', status: 'ok', duration_ms: 11 },
        { at: 12_000, to: 'bob', do: 'answer', text: 'Yes; details are in the team notes under staging.' },
        { at: 13_000, to: 'bob', do: 'answer_delivered' },
      ],
    },
    {
      offset: 32_000,
      kind: 'question',
      asker: 'alice',
      to: ['carol'],
      broadcast: false,
      question: 'Can you check why the staging data refresh did not run last night?',
      ackTimeout: 10,
      answerTimeout: 25,
      steps: [
        { at: 900, to: 'carol', do: 'deliver' },
        { at: 2400, to: 'carol', do: 'ack' },
        { at: 4000, to: 'carol', do: 'tool', tool: 'Grep', status: 'ok', duration_ms: 44 },
        { at: 6500, to: 'carol', do: 'tool', tool: 'Read', status: 'ok', duration_ms: 15 },
      ],
    },
    {
      offset: 40_000,
      kind: 'capability',
      asker: 'bob',
      to: ['carol'],
      broadcast: false,
      capability: { name: 'service_health', params: { service: ['worker', 'api', 'web'][v]! } },
      ackTimeout: 120,
      answerTimeout: 1800,
      steps: [
        { at: 800, to: 'carol', do: 'deliver' },
        { at: 2000, to: 'carol', do: 'ack' },
        { at: 3000, to: 'carol', do: 'progress', text: 'calling the health endpoint', pct: 50 },
        { at: 4800, to: 'carol', do: 'tool', tool: 'service_health', status: 'ok', duration_ms: 1800 },
        { at: 7000, to: 'carol', do: 'answer', text: 'Healthy, no errors in the last hour.' },
        { at: 8000, to: 'carol', do: 'answer_delivered' },
      ],
    },
    {
      // Created as carol's answer above is returned (40 s + 8 s): the same updated_at.
      offset: 48_000,
      kind: 'question',
      asker: 'carol',
      to: ['alice', 'bob'],
      broadcast: true,
      question: 'Which of you knows how the staging cache is warmed after a deploy?',
      ackTimeout: 60,
      answerTimeout: 600,
      steps: [
        // Delivered to both in the same millisecond: two changes, the second stamped 1 ms on.
        { at: 800, to: 'alice', do: 'deliver' },
        { at: 800, to: 'bob', do: 'deliver' },
        { at: 2000, to: 'bob', do: 'ack' },
        { at: 2600, to: 'alice', do: 'ack' },
        { at: 3500, to: 'alice', do: 'tool', tool: 'Grep', status: 'ok', duration_ms: 27 },
        { at: 6000, to: 'bob', do: 'answer', text: 'A post-deploy job requests the ten busiest pages once each.' },
        { at: 6800, to: 'bob', do: 'answer_delivered' },
        { at: 8000, to: 'alice', do: 'answer', text: 'The deploy pipeline runs a warm-up step; the page list is in its config.' },
        { at: 9000, to: 'alice', do: 'answer_delivered' },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString();

/** Stable per (epoch, cycle, index), shaped like a relay request id. */
function requestId(epoch: number, cycle: number, index: number): string {
  return `rq_${createHash('sha256').update(`team-relay-demo:${epoch}:${cycle}:${index}`).digest('hex').slice(0, 32)}`;
}

type Materialised = {
  doc: ActivityRequest; // the full (participant) view
  progress: ProgressItem[];
};

function materialise(s: Script, created: number, id: string, now: number, environments: Map<string, string>): Materialised | null {
  if (created > now) return null;
  const recipients: Record<string, RecipientView> = {};
  for (const m of s.to) {
    recipients[m] = {
      status: 'pending',
      delivered_at: null,
      acked_at: null,
      answered_at: null,
      answer_delivered_at: null,
      tools: [],
      progress_count: 0,
      last_progress_pct: null,
      answer_preview: null,
    };
  }
  const progress: ProgressItem[] = [];
  let updated = created;
  const ackDeadline = created + s.ackTimeout * 1000;
  const answerDeadline = created + s.answerTimeout * 1000;
  // Deadlines become events too (the relay's sweep), in time order with the scripted steps.
  type Timed = { at: number; apply: () => void };
  const events: Timed[] = s.steps.map((step) => ({
    at: created + step.at,
    apply: () => {
      const r = recipients[step.to]!;
      const t = iso(created + step.at);
      switch (step.do) {
        case 'deliver':
          r.delivered_at ??= t;
          break;
        case 'ack':
          if (r.status === 'pending' || r.status === 'no_response') r.status = 'acked';
          r.acked_at ??= t;
          break;
        case 'tool':
          r.tools.push({ tool: step.tool, status: step.status, at: t, duration_ms: step.duration_ms });
          progress.push({ seq: progress.length + 1, member: step.to, kind: 'tool', tool: step.tool, status: step.status, duration_ms: step.duration_ms, time: t });
          break;
        case 'progress':
          r.progress_count++;
          r.last_progress_pct = step.pct;
          progress.push({ seq: progress.length + 1, member: step.to, kind: 'progress', text: step.text, pct: step.pct, time: t });
          break;
        case 'answer':
          r.status = 'answered';
          r.acked_at ??= t;
          r.answered_at = t;
          r.answer_preview = step.text.slice(0, PREVIEW_CHARS);
          break;
        case 'answer_delivered':
          r.answer_delivered_at ??= t;
          break;
      }
    },
  }));
  // The sweep records a passed deadline a moment later (it runs on the relay's own schedule).
  for (const m of s.to) {
    events.push({ at: ackDeadline + SWEEP_LAG_MS, apply: () => void (recipients[m]!.status === 'pending' && (recipients[m]!.status = 'no_response')) });
    events.push({ at: answerDeadline + SWEEP_LAG_MS, apply: () => void (recipients[m]!.status === 'acked' && (recipients[m]!.status = 'timed_out')) });
  }
  events.sort((a, b) => a.at - b.at);
  for (const e of events) {
    if (e.at > now) break;
    const before = JSON.stringify(recipients);
    e.apply();
    // M2-SPEC §7.1: every change stamps max(now, previous updated_at + 1 ms).
    if (JSON.stringify(recipients) !== before) updated = Math.max(e.at, updated + 1);
  }
  const doc: ActivityRequest = {
    request_id: id,
    kind: s.kind,
    asker: s.asker,
    broadcast: s.broadcast,
    created_at: iso(created),
    updated_at: iso(updated),
    ack_deadline: iso(ackDeadline),
    answer_deadline: iso(answerDeadline),
    expire_at: iso(created + DEMO_TTL_MS),
    capability: s.capability
      ? { name: s.capability.name, environment: environments.get(s.capability.name) ?? 'staging', params: { ...s.capability.params } }
      : null,
    question: s.question ?? null,
    recipients,
    participant: true,
  };
  return { doc, progress };
}

/**
 * The view `viewer` gets (M2-SPEC §3.5): the question and params only for participants; an
 * answer preview only for the asker and for the recipient who wrote it (as in §3.11, where a
 * recipient sees only its own entry), which is also how the relay reads it.
 */
function viewFor(doc: ActivityRequest, viewer: string): ActivityRequest {
  const isAsker = doc.asker === viewer;
  const participant = isAsker || Object.hasOwn(doc.recipients, viewer);
  const recipients: Record<string, RecipientView> = {};
  for (const [m, r] of Object.entries(doc.recipients)) {
    recipients[m] = { ...r, answer_preview: isAsker || m === viewer ? r.answer_preview : null };
  }
  return {
    ...doc,
    question: participant ? doc.question : null,
    capability: doc.capability ? { ...doc.capability, params: participant ? doc.capability.params : null } : null,
    recipients,
    participant,
  };
}

/** M2-SPEC §7.2: open while the deadline for the stored status is still ahead. */
export function stillOpen(doc: ActivityRequest, r: RecipientView, now: number): boolean {
  if (r.status === 'pending') return now < Date.parse(doc.ack_deadline);
  if (r.status === 'acked') return now < Date.parse(doc.answer_deadline);
  return false;
}

/** The median, rounded to 3 decimals as the relay rounds it; null for none. */
export function median3(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  const m = v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
  return Math.round(m * 1000) / 1000;
}

function memberStats(docs: ActivityRequest[], member: string, start: number, now: number) {
  let asked = 0;
  let answered = 0;
  let open = 0;
  const seconds: number[] = [];
  for (const d of docs) {
    if (d.asker === member && Date.parse(d.created_at) >= start) asked++;
    const r = d.recipients[member];
    if (!r) continue;
    if (r.answered_at !== null && Date.parse(r.answered_at) >= start) {
      answered++;
      seconds.push((Date.parse(r.answered_at) - Date.parse(d.created_at)) / 1000);
    }
    if (stillOpen(d, r, now)) open++;
  }
  return { asked, answered, open, median_answer_seconds: median3(seconds) };
}

export class NotFound extends Error {
  constructor() {
    super('not_found');
    this.name = 'NotFound';
  }
}

export class BadRequest extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'BadRequest';
  }
}

export class DemoTeam {
  private readonly epoch: number;
  private readonly manifests: Record<Member, Manifest | null>;
  private readonly environments = new Map<string, string>();
  private readonly publishedAt: string;

  constructor(
    private readonly now: () => number = Date.now,
    manifestPath: string = defaultManifestPath(),
  ) {
    const start = now();
    // Cycles are aligned to the wall clock, starting a few cycles back.
    this.epoch = Math.floor(start / DEMO_CYCLE_MS) * DEMO_CYCLE_MS - WARMUP_CYCLES * DEMO_CYCLE_MS;
    const manifest = loadManifest(manifestPath);
    const pick = (names: string[]): Manifest => ({
      version: 1,
      capabilities: manifest.capabilities.filter((c: Capability) => names.includes(c.name)),
    });
    for (const c of manifest.capabilities) this.environments.set(c.name, c.environment);
    this.manifests = {
      alice: null,
      bob: pick(['staging_db_query']),
      carol: pick(['service_health', 'production_db_count']),
    };
    this.publishedAt = iso(this.epoch - 3_600_000);
  }

  /** Every request created by `now`; expired ones only when asked for (the feed passes them). */
  private all(now: number, withExpired = false): Materialised[] {
    const out: Materialised[] = [];
    const first = Math.max(0, Math.floor((now - DEMO_TTL_MS - this.epoch) / DEMO_CYCLE_MS) - 1);
    const last = Math.floor((now - this.epoch) / DEMO_CYCLE_MS);
    for (let c = first; c <= last; c++) {
      const cycleStart = this.epoch + c * DEMO_CYCLE_MS;
      scripts(c).forEach((s, i) => {
        const m = materialise(s, cycleStart + s.offset, requestId(this.epoch, c, i), now, this.environments);
        if (m && (withExpired || Date.parse(m.doc.expire_at) > now)) out.push(m);
      });
    }
    return out;
  }

  me() {
    return { team: DEMO_TEAM, member: DEMO_ME, teammates: DEMO_MEMBERS.filter((m) => m !== DEMO_ME) };
  }

  private presence(member: Member, now: number): { working: string | null; answering: string | null } {
    // Presence is written at most once per 15 s per stream (M2-SPEC §3.1).
    const tick = (offset: number) => iso(Math.floor((now - offset) / 15_000) * 15_000);
    const cycleStart = this.epoch + Math.floor((now - this.epoch) / DEMO_CYCLE_MS) * DEMO_CYCLE_MS;
    switch (member) {
      case 'bob':
        return { working: tick(2000), answering: tick(1000) };
      case 'carol':
        // The working session goes quiet within each cycle: online, then idle.
        return { working: iso(cycleStart + 3000), answering: tick(4000) };
      default:
        return { working: tick(0), answering: tick(500) };
    }
  }

  /**
   * M2-SPEC §3.1, §3.6 as the relay computes them: one read of the most recently updated
   * requests of the last 24 h (at most STATS_READ_CAP, `stats_complete` false when the cap was
   * reached), expired ones left out; `asked` by creation in the window, `answered` and the
   * median by `answered_at` in the window, `open` by effective status (§7.2).
   */
  directory() {
    const now = this.now();
    const start = now - DAY_MS;
    const read = this.all(now)
      .map((m) => m.doc)
      .filter((d) => Date.parse(d.updated_at) > start)
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.request_id.localeCompare(a.request_id))
      .slice(0, STATS_READ_CAP);
    const members = DEMO_MEMBERS.filter((m) => m !== DEMO_ME).map((member) => {
      const p = this.presence(member, now);
      const seen = [p.working, p.answering].filter((x): x is string => x !== null).sort();
      const manifest = this.manifests[member];
      return {
        member,
        last_seen: seen.at(-1) ?? null,
        manifest,
        published_at: manifest ? this.publishedAt : null,
        sessions: { working: { last_seen: p.working }, answering: { last_seen: p.answering } },
        stats: memberStats(read, member, start, now),
      };
    });
    return { members, stats_complete: read.length < STATS_READ_CAP };
  }

  /**
   * M2-SPEC §3.5 with §7.10: ascending by updated_at, since-exclusive, at most `limit`, except
   * that a page never splits the requests sharing one updated_at: it is cut before such a
   * group, or, when the whole page is one group, returns all of it (up to 500). `next_since`
   * is the updated_at of the last request read, expired or not; expired ones are not returned.
   */
  activity(q: { since?: string; limit?: number } = {}) {
    const now = this.now();
    let since: number;
    if (q.since === undefined) since = now - DAY_MS;
    else {
      since = Date.parse(q.since);
      if (!Number.isFinite(since)) throw new BadRequest('since must be an RFC 3339 time');
    }
    const limit = q.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new BadRequest('limit must be 1..200');
    const read = this.all(now, true)
      .map((m) => m.doc)
      .filter((d) => Date.parse(d.updated_at) > since)
      .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.request_id.localeCompare(b.request_id));
    let page = read.slice(0, limit);
    if (read.length > limit && read[limit]!.updated_at === page.at(-1)!.updated_at) {
      const boundary = page.at(-1)!.updated_at;
      const before = page.filter((d) => d.updated_at !== boundary);
      page = before.length > 0 ? before : read.filter((d) => d.updated_at === boundary).slice(0, ACTIVITY_MAX_GROUP);
    }
    return {
      requests: page.filter((d) => Date.parse(d.expire_at) > now).map((d) => viewFor(d, DEMO_ME)),
      next_since: page.length > 0 ? page.at(-1)!.updated_at : iso(since),
      server_time: iso(now),
    };
  }

  /**
   * M1-SPEC §3.11 as alice, in the relay's shape: the asker sees every recipient, a recipient
   * only itself; progress holds progress and tool events in one shape (M2-SPEC §3.3), the
   * fields that do not apply to a kind being null.
   */
  request(id: string) {
    const now = this.now();
    const found = this.all(now).find((m) => m.doc.request_id === id);
    if (!found) throw new NotFound();
    const { doc, progress } = found;
    const isAsker = doc.asker === DEMO_ME;
    if (!isAsker && !doc.recipients[DEMO_ME]) throw new NotFound();
    const recipients: Record<string, { status: Status; acked_at: string | null; answered_at: string | null }> = {};
    for (const [m, r] of Object.entries(doc.recipients)) {
      if (isAsker || m === DEMO_ME) recipients[m] = { status: r.status, acked_at: r.acked_at, answered_at: r.answered_at };
    }
    return {
      request_id: doc.request_id,
      kind: doc.kind,
      asker: doc.asker,
      broadcast: doc.broadcast,
      question: doc.question,
      capability: doc.capability,
      created_at: doc.created_at,
      ack_deadline: doc.ack_deadline,
      answer_deadline: doc.answer_deadline,
      expire_at: doc.expire_at,
      recipients,
      progress: progress
        .filter((p) => isAsker || p.member === DEMO_ME)
        .map((p) =>
          p.kind === 'progress'
            ? { seq: p.seq, member: p.member, kind: p.kind, text: p.text, pct: p.pct, tool: null, status: null, duration_ms: null, time: p.time }
            : { seq: p.seq, member: p.member, kind: p.kind, text: null, pct: null, tool: p.tool, status: p.status, duration_ms: p.duration_ms, time: p.time },
        ),
    };
  }
}
