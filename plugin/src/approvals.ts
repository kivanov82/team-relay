// What waits for the member (M8-SPEC §3, §4): a tool use outside the automatic class (a read
// outside the scope folder, a capability run) or a draft answer that must not ship on its own.
// Nothing here decides anything: an item is decided only by the member, through the
// elicitation dialog or the local approvals page (approvals-review.ts, approvals-page.ts), or
// it lapses. An item lapses when its question's answer deadline passes or after 30 minutes,
// whichever is sooner (deny on timeout).

import { randomBytes } from 'node:crypto';

/** The longest an approval waits. */
export const MAX_WAIT_MS = 30 * 60_000;

export type ItemContext = {
  request_id: string;
  /** The teammate who asked (an id). */
  asker: string;
  kind: 'question' | 'capability_call';
  /** The teammate's question (teammate-authored data), or the capability call described. */
  question: string;
  capability?: { name: string; params: Record<string, unknown> };
};

export type PermissionAsk = {
  type: 'permission';
  /** The tool's short name, as tool events carry it (Read, Grep, a capability name). */
  tool: string;
  /** What the member is asked to allow, in one line ("read /abs/path"). */
  action: string;
};

export type DraftAsk = {
  type: 'draft';
  text: string;
  data: Record<string, unknown> | null;
  /** Why it waits: the answerer's flag, the secret screen, an approval during the run. */
  reasons: string[];
};

export type PermissionDecision = 'allow' | 'deny';
export type DraftDecision = 'send' | 'dont_send' | 'decline';
export type Outcome<D extends string> = D | 'lapsed' | 'cancelled';

export type Pending = {
  id: string;
  ctx: ItemContext;
  ask: PermissionAsk | DraftAsk;
  created_at: number;
  deadline: number;
};

export const PERMISSION_DECISIONS: readonly PermissionDecision[] = ['allow', 'deny'];
export const DRAFT_DECISIONS: readonly DraftDecision[] = ['send', 'dont_send', 'decline'];

type Entry = Pending & { settle: (outcome: string) => void; timer: NodeJS.Timeout };

export class ApprovalQueue {
  private readonly items = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly listeners = new Set<(event: { type: 'added' | 'settled'; item: Pending; outcome?: string }) => void>();

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  onChange(fn: (event: { type: 'added' | 'settled'; item: Pending; outcome?: string }) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(type: 'added' | 'settled', item: Pending, outcome?: string) {
    for (const fn of this.listeners) {
      try {
        fn({ type, item, ...(outcome !== undefined ? { outcome } : {}) });
      } catch {
        // a listener's failure never blocks a decision
      }
    }
  }

  /** The deadline an item added now gets: the answer deadline or 30 minutes, whichever is sooner. */
  deadlineFor(answerDeadline: number): number {
    const cap = this.now() + MAX_WAIT_MS;
    return Number.isFinite(answerDeadline) ? Math.min(answerDeadline, cap) : cap;
  }

  add(ctx: ItemContext, ask: PermissionAsk, answerDeadline: number): { id: string; outcome: Promise<Outcome<PermissionDecision>> };
  add(ctx: ItemContext, ask: DraftAsk, answerDeadline: number): { id: string; outcome: Promise<Outcome<DraftDecision>> };
  add(ctx: ItemContext, ask: PermissionAsk | DraftAsk, answerDeadline: number): { id: string; outcome: Promise<string> } {
    const id = `ap_${randomBytes(8).toString('hex')}`;
    const deadline = this.deadlineFor(answerDeadline);
    let settle!: (outcome: string) => void;
    const outcome = new Promise<string>((resolve) => {
      settle = resolve;
    });
    const delay = Math.max(0, deadline - this.now());
    const timer = setTimeout(() => this.finish(id, 'lapsed'), delay);
    timer.unref();
    const entry: Entry = { id, ctx, ask, created_at: this.now(), deadline, settle, timer };
    this.items.set(id, entry);
    this.emit('added', this.view(entry));
    return { id, outcome };
  }

  private view(e: Entry): Pending {
    return { id: e.id, ctx: e.ctx, ask: e.ask, created_at: e.created_at, deadline: e.deadline };
  }

  private finish(id: string, outcome: string): boolean {
    const e = this.items.get(id);
    if (!e) return false;
    this.items.delete(id);
    clearTimeout(e.timer);
    e.settle(outcome);
    this.emit('settled', this.view(e), outcome);
    return true;
  }

  /** Oldest first. */
  list(): Pending[] {
    return [...this.items.values()].sort((a, b) => a.created_at - b.created_at).map((e) => this.view(e));
  }

  get(id: string): Pending | null {
    const e = this.items.get(id);
    return e ? this.view(e) : null;
  }

  get size(): number {
    return this.items.size;
  }

  /**
   * The member's decision on one item. Refused (false) when the item is gone (decided, lapsed)
   * or the decision is not one its kind takes. A past-deadline item lapses instead.
   */
  decide(id: string, decision: string): boolean {
    const e = this.items.get(id);
    if (!e) return false;
    const allowed: readonly string[] = e.ask.type === 'permission' ? PERMISSION_DECISIONS : DRAFT_DECISIONS;
    if (!allowed.includes(decision)) return false;
    if (this.now() >= e.deadline) {
      this.finish(id, 'lapsed');
      return false;
    }
    return this.finish(id, decision);
  }

  /** Withdrawn (the run that asked ended, or the host stops): denied, never allowed. */
  cancel(id: string): boolean {
    return this.finish(id, 'cancelled');
  }

  cancelWhere(pred: (item: Pending) => boolean): number {
    let n = 0;
    for (const e of [...this.items.values()]) if (pred(this.view(e)) && this.cancel(e.id)) n++;
    return n;
  }

  cancelAll(): number {
    return this.cancelWhere(() => true);
  }
}
