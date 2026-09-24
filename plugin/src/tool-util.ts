import { RelayError, RelayNetworkError } from './relay-client.js';

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export function toolJson(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** A message for a tool error. Never includes the token (no error here carries it). */
export function describeError(err: unknown): string {
  if (err instanceof RelayError) {
    return `relay refused (${err.status} ${err.code})${err.detail ? `: ${err.detail}` : ''}`;
  }
  if (err instanceof RelayNetworkError) return err.message;
  if (err instanceof Error) return err.message;
  return 'unexpected error';
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** JSON with object keys sorted at every level, so two equal values serialise identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Reject keys outside `allowed`; returns the first unknown key or null. */
export function unknownKey(args: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const k of Object.keys(args)) if (!allowed.includes(k)) return k;
  return null;
}

export function optionalInt(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return v;
}
