// How the member decides (M8-SPEC §4): /team-relay:approvals (the review_approvals tool) goes
// through the pending items one at a time with MCP elicitation. Claude Code shows each as a
// dialog; the member's choice in that dialog is the decision. The model that called the tool
// sees only the counts afterwards: it never sees a decision to make, and a tool call alone
// approves nothing.
//
// Claude Code (2.1.282) advertises `elicitation: {}` (form mode) and renders flat forms of
// string, number, integer, boolean and string-enum fields (`enum` with `enumNames`, or `oneOf`
// of {const, title}); the dialog's own Accept / Decline / Esc are separate from the fields.
// Here: one required single-choice field. Accept with a choice decides that item; Decline or
// Esc leaves it pending and ends the review (it still lapses at its deadline, which denies).

import { neutraliseChannelTags } from './notify.js';
import { type ApprovalQueue, type Pending } from './approvals.js';

/** The longest draft shown whole in a dialog (measured as shown, quote marks included); longer ones cannot be sent from it. */
export const DIALOG_DRAFT_LIMIT = 8000;
/** How much of a draft that cannot be sent from the dialog is shown. */
const DRAFT_PREVIEW_LIMIT = 1500;
const QUESTION_LIMIT = 2000;

export type ElicitParams = {
  message: string;
  requestedSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
};
export type ElicitResult = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
export type Elicit = (params: ElicitParams, timeoutMs: number) => Promise<ElicitResult>;

export type ReviewSummary = {
  reviewed: number;
  allowed: number;
  denied: number;
  sent: number;
  declined: number;
  not_sent: number;
  /** Lapsed or decided elsewhere while its dialog was open. */
  gone: number;
  still_pending: number;
  stopped_early: boolean;
};

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)} …[${text.length - limit} more characters not shown]`;
}

function quoteLines(text: string): string {
  return text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

/** The teammate's text as the dialog quotes it: tags neutralised, clipped, each line quoted. */
export function quoteTeammate(text: string, limit = QUESTION_LIMIT): string {
  return quoteLines(clip(neutraliseChannelTags(text), limit));
}

/** Exactly what would be sent: the text, and the data as JSON after it. */
export function draftBody(item: Pending): string {
  if (item.ask.type !== 'draft') return '';
  return item.ask.data ? `${item.ask.text}\n\nData: ${JSON.stringify(item.ask.data, null, 2)}` : item.ask.text;
}

/**
 * Characters a dialog or a page cannot show as they are: controls (bar newline and tab),
 * direction overrides and invisible characters. A draft holding one cannot be shown exactly,
 * so it cannot be sent from where it is shown.
 */
const UNSHOWABLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/u;
const UNSHOWABLE_ALL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/gu;

/** Whether the text can be shown exactly as it is (no character that hides or reorders text, no channel tag to neutralise). */
export function showable(text: string): boolean {
  return !UNSHOWABLE.test(text) && neutraliseChannelTags(text) === text;
}

/** A draft that cannot be shown exactly, made visible: every such character as \u{…}. */
export function visibleEscapes(text: string): string {
  return neutraliseChannelTags(text).replace(UNSHOWABLE_ALL, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

/**
 * How the dialog shows a draft (M8-SPEC §7 item 8): the string measured is the string shown.
 * `whole` is true only when that string is the entire draft, exactly, quote marks aside;
 * only then is Send offered.
 */
export function shownDraft(item: Pending): { shown: string; whole: boolean } {
  const body = draftBody(item);
  const full = quoteLines(body);
  if (showable(body) && full.length <= DIALOG_DRAFT_LIMIT) return { shown: full, whole: true };
  return { shown: quoteLines(clip(visibleEscapes(body), DRAFT_PREVIEW_LIMIT)), whole: false };
}

/** Whether a draft is shown whole and exactly, and so can be sent, from the dialog. */
export function draftFits(item: Pending): boolean {
  return shownDraft(item).whole;
}

type Choice = { const: string; title: string };

export function choicesFor(item: Pending): Choice[] {
  if (item.ask.type === 'permission') {
    return [
      { const: 'allow', title: 'Allow (this once, for this question)' },
      { const: 'deny', title: 'Deny' },
    ];
  }
  if (item.ask.type === 'run') {
    return [
      { const: 'allow', title: 'Answer it automatically (the answer may still wait for you)' },
      { const: 'deny', title: "Don't answer (nothing is sent)" },
      { const: 'decline', title: 'Decline politely (say I did not approve it)' },
    ];
  }
  const out: Choice[] = [];
  if (draftFits(item)) out.push({ const: 'send', title: 'Send this answer' });
  out.push({ const: 'dont_send', title: "Don't send (nothing is sent)" }, { const: 'decline', title: 'Decline politely (say I did not approve it)' });
  return out;
}

/** The dialog for one item. Everything a teammate wrote is quoted and labelled as theirs. */
export function elicitationFor(item: Pending, index: number, total: number, member: string): ElicitParams {
  const { ctx } = item;
  const lines = [`Team relay: approval ${index} of ${total}.`, ''];
  if (ctx.kind === 'capability_call' && ctx.capability) {
    lines.push(`${ctx.asker} asked you to run ${ctx.capability.name} with these params (teammate data):`, quoteTeammate(JSON.stringify(ctx.capability.params)));
  } else {
    lines.push(`${ctx.asker} asked (teammate text, as they wrote it):`, quoteTeammate(ctx.question));
  }
  lines.push('');
  const politely = `"Decline politely" sends: "I couldn't answer this automatically; ${member} hasn't approved it."`;
  if (item.ask.type === 'permission') {
    lines.push(`Your automatic answerer wants to ${item.ask.action}.`, 'Allow lets it do this once, for this question only.');
  } else if (item.ask.type === 'run') {
    lines.push(
      `This question waits for your approval before your automatic answerer works on it: ${item.ask.reason}.`,
      'Answering it automatically follows the usual rules: what it reads outside the folder, and its answer when needed, still wait for you.',
      '',
      politely,
    );
  } else {
    lines.push(`The answer your automatic answerer drafted waits for you because: ${item.ask.reasons.join('; ')}.`, '');
    const { shown, whole } = shownDraft(item);
    if (whole) {
      lines.push('The draft, exactly as it would be sent (each line marked with "> "; the marks are not sent):', shown);
    } else {
      lines.push(
        showable(draftBody(item))
          ? `The draft is too long to show here in full (${draftBody(item).length} characters), so it cannot be sent from this dialog. Its beginning:`
          : 'The draft holds characters that cannot be shown here as they are (shown below as \\u{…}), so it cannot be sent from this dialog. Its beginning:',
        shown,
      );
    }
    lines.push('', politely);
  }
  lines.push('', 'Decline or Esc: decide later (it is denied if you have not decided by its deadline).');
  return {
    message: lines.join('\n'),
    requestedSchema: {
      type: 'object',
      properties: {
        decision: { type: 'string', title: 'Your decision', oneOf: choicesFor(item) },
      },
      required: ['decision'],
    },
  };
}

/**
 * Go through what is pending, oldest first, one dialog each. Items added meanwhile are
 * included. Stops at the first Decline / Esc, or when a dialog fails.
 */
export async function reviewWithElicitation(
  queue: ApprovalQueue,
  elicit: Elicit,
  member: string,
  now: () => number = Date.now,
): Promise<ReviewSummary> {
  const s: ReviewSummary = { reviewed: 0, allowed: 0, denied: 0, sent: 0, declined: 0, not_sent: 0, gone: 0, still_pending: 0, stopped_early: false };
  const seen = new Set<string>();
  for (;;) {
    const pending = queue.list().filter((p) => !seen.has(p.id));
    const item = pending[0];
    if (!item) break;
    seen.add(item.id);
    const total = seen.size + pending.length - 1;
    const timeout = Math.max(1000, item.deadline - now());
    let res: ElicitResult;
    try {
      res = await elicit(elicitationFor(item, seen.size, total, member), timeout);
    } catch {
      s.stopped_early = true;
      break;
    }
    if (res.action !== 'accept') {
      s.stopped_early = true;
      break;
    }
    s.reviewed++;
    const decision = typeof res.content?.decision === 'string' ? res.content.decision : '';
    const offered = choicesFor(item).map((c) => c.const);
    if (!offered.includes(decision) || !queue.decide(item.id, decision)) {
      s.gone++;
      continue;
    }
    if (decision === 'allow') s.allowed++;
    else if (decision === 'deny') s.denied++;
    else if (decision === 'send') s.sent++;
    else if (decision === 'decline') s.declined++;
    else s.not_sent++;
  }
  s.still_pending = queue.size;
  return s;
}

export function summaryText(s: ReviewSummary): string {
  const parts: string[] = [];
  if (s.allowed) parts.push(`${s.allowed} allowed`);
  if (s.denied) parts.push(`${s.denied} denied`);
  if (s.sent) parts.push(`${s.sent} answer${s.sent === 1 ? '' : 's'} sent`);
  if (s.declined) parts.push(`${s.declined} declined politely`);
  if (s.not_sent) parts.push(`${s.not_sent} not sent`);
  if (s.gone) parts.push(`${s.gone} no longer pending`);
  const done = parts.length ? parts.join(', ') : 'nothing decided';
  const left = s.still_pending ? ` ${s.still_pending} still waiting for your approval.` : ' Nothing else is waiting.';
  return `Reviewed ${s.reviewed}: ${done}.${left}`;
}
