// Envelope → notifications/claude/channel params (M1-SPEC §8.2).
//
// Meta keys are identifiers only (Claude Code silently drops anything else). Meta values
// are checked against the id shapes the relay guarantees, so nothing a teammate typed can
// land in a tag attribute; teammate text only ever reaches `content`.

import {
  MEMBER_RE,
  MESSAGE_ID_RE,
  REQUEST_ID_RE,
  type Envelope,
  type EnvelopeType,
  type StreamName,
} from './relay-client.js';

export type ChannelNotification = { content: string; meta: Record<string, string> };

export const DATA_JSON_LIMIT = 16 * 1024;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const CAPABILITY_RE = /^[a-z][a-z0-9_]{1,62}$/;

/** Which envelope types each stream may carry; anything else is skipped, not pushed. */
export const STREAM_TYPES: Record<StreamName, ReadonlySet<EnvelopeType>> = {
  inbox: new Set<EnvelopeType>(['question', 'capability_call']),
  replies: new Set<EnvelopeType>(['answer', 'no_response', 'timed_out']),
};

/** Truncate to at most `limit` UTF-8 bytes without splitting a character. */
export function truncateUtf8(text: string, limit: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= limit) return text;
  const marker = ' …[truncated]';
  let end = limit - Buffer.byteLength(marker, 'utf8');
  // Step back to a character boundary (continuation bytes are 10xxxxxx).
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8') + marker;
}

/**
 * Keep a teammate's text from closing or opening the <channel> tag it is wrapped in.
 * Only the tag name sequence is touched; everything else passes through verbatim.
 */
export function neutraliseChannelTags(text: string): string {
  return text.replace(/<(\/?)(channel)/gi, '&lt;$1$2');
}

/**
 * {@link neutraliseChannelTags} applied to every string in a JSON value, object keys
 * included. Used for tool results that carry teammate-authored text (M1-SPEC §11.12).
 */
export function neutraliseDeep(value: unknown): unknown {
  if (typeof value === 'string') return neutraliseChannelTags(value);
  if (Array.isArray(value)) return value.map(neutraliseDeep);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[neutraliseChannelTags(k)] = neutraliseDeep(v);
    return out;
  }
  return value;
}

export type Rejection = { reject: string };

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Map one envelope to a channel notification, or say why it is not pushed.
 * `expect` is what this process reads: its own stream, team and member.
 */
export function envelopeToNotification(
  env: Envelope,
  expect: { stream: StreamName; team: string; member: string },
): ChannelNotification | Rejection {
  if (typeof env !== 'object' || env === null) return { reject: 'not an object' };
  if (!MESSAGE_ID_RE.test(str(env.id) ?? '')) return { reject: 'bad message id' };
  if (!REQUEST_ID_RE.test(str(env.request_id) ?? '')) return { reject: 'bad request id' };
  if (env.stream !== expect.stream) return { reject: 'wrong stream' };
  if (env.team !== expect.team) return { reject: 'wrong team' };
  if (env.to !== expect.member) return { reject: 'not addressed to this member' };
  if (!STREAM_TYPES[expect.stream].has(env.type)) return { reject: `type ${String(env.type)} is not pushed on ${expect.stream}` };
  const data = (typeof env.data === 'object' && env.data !== null ? env.data : {}) as Record<string, unknown>;
  const from = str(env.from) ?? '';
  const base = { type: env.type, request_id: env.request_id, message_id: env.id };

  switch (env.type) {
    case 'question': {
      if (!MEMBER_RE.test(from)) return { reject: 'bad sender' };
      const question = str(data.question);
      const ackDeadline = str(data.ack_deadline) ?? '';
      if (question === undefined) return { reject: 'question without text' };
      if (!RFC3339.test(ackDeadline)) return { reject: 'bad ack_deadline' };
      return {
        content: neutraliseChannelTags(question),
        meta: { ...base, from, ack_deadline: ackDeadline, broadcast: env.broadcast === true ? 'true' : 'false' },
      };
    }
    case 'capability_call': {
      if (!MEMBER_RE.test(from)) return { reject: 'bad sender' };
      const capability = str(data.capability) ?? '';
      const ackDeadline = str(data.ack_deadline) ?? '';
      if (!CAPABILITY_RE.test(capability)) return { reject: 'bad capability name' };
      if (!RFC3339.test(ackDeadline)) return { reject: 'bad ack_deadline' };
      const params = typeof data.params === 'object' && data.params !== null ? data.params : {};
      return {
        content: neutraliseChannelTags(`${from} asks you to run ${capability} with ${JSON.stringify(params)}`),
        meta: {
          ...base,
          from,
          ack_deadline: ackDeadline,
          broadcast: env.broadcast === true ? 'true' : 'false',
          capability,
        },
      };
    }
    case 'answer': {
      if (!MEMBER_RE.test(from)) return { reject: 'bad sender' };
      const text = str(data.text);
      if (text === undefined) return { reject: 'answer without text' };
      let content = text;
      if (data.data !== undefined && data.data !== null) {
        content += `\n\n${truncateUtf8(JSON.stringify(data.data), DATA_JSON_LIMIT)}`;
      }
      return { content: neutraliseChannelTags(content), meta: { ...base, from } };
    }
    case 'no_response':
    case 'timed_out': {
      const member = str(data.member) ?? '';
      if (!MEMBER_RE.test(member)) return { reject: 'bad member' };
      const detail = str(data.detail) ?? (env.type === 'no_response' ? `No response yet from ${member}.` : `${member} acknowledged but has not answered yet.`);
      return { content: neutraliseChannelTags(detail), meta: { ...base, member } };
    }
    default:
      return { reject: 'unknown type' };
  }
}

/** A bounded set of recently pushed message ids (duplicate suppression in one process). */
export class RecentIds {
  private readonly order: string[] = [];
  private readonly set = new Set<string>();
  constructor(private readonly capacity = 500) {}
  has(id: string): boolean {
    return this.set.has(id);
  }
  add(id: string): void {
    if (this.set.has(id)) return;
    this.set.add(id);
    this.order.push(id);
    while (this.order.length > this.capacity) {
      const old = this.order.shift();
      if (old !== undefined) this.set.delete(old);
    }
  }
}
