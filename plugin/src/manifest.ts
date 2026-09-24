// Capability manifest: load, validate (JSON Schema plus the relay-side checks of
// M1-SPEC §3.3 and §11), and validate a call's params (the rules of §3.5 and §11.2).
//
// Patterns are RE2 (M1-SPEC §11.1): a manifest can be published by any teammate, so every
// pattern is compiled and matched by re2js, which runs in linear time. No manifest pattern
// is ever handed to a JavaScript RegExp.
//
// The schema file lives at the repo root (../schema). esbuild inlines it into each bundle,
// so the installed plugin does not need the schema directory next to it.

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import _Ajv2020 from 'ajv/dist/2020.js';
import { RE2JS } from 're2js';
import schema from '../../schema/manifest.schema.json' with { type: 'json' };

export type EnumParam = { type: 'enum'; description: string; values: string[]; default?: string };
export type StringParam = {
  type: 'string';
  description: string;
  max_length: number;
  pattern: string;
  default?: string;
};
export type IntegerParam = { type: 'integer'; description: string; min: number; max: number; default?: number };
export type NumberParam = { type: 'number'; description: string; min: number; max: number; default?: number };
export type BooleanParam = { type: 'boolean'; description: string; default?: boolean };
export type Param = EnumParam | StringParam | IntegerParam | NumberParam | BooleanParam;

export type Capability = {
  name: string;
  title: string;
  description: string;
  environment: 'staging' | 'production';
  default_enabled?: boolean;
  timeout_seconds?: number;
  params: Record<string, Param>;
  required?: string[];
};

/** A folder the member's answering session may read for teammates, by name only (M4-SPEC §3). */
export type Share = { name: string };
export type Manifest = { version: 1; capabilities: Capability[]; shares?: Share[] };

/** A share name: a folder's basename in a safe alphabet (schema `$defs/share`). */
export const SHARE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** At most this many shares (schema `properties.shares.maxItems`). */
export const MAX_SHARES = 16;

export class ManifestError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid manifest: ${problems.join('; ')}`);
    this.name = 'ManifestError';
    this.problems = problems;
  }
}

export const DEFAULT_TIMEOUT_SECONDS = 120;
/** Longest pattern a manifest may carry, in code points (M1-SPEC §11.1). */
export const MAX_PATTERN_LENGTH = 300;
/** Largest magnitude an integer or number param may take (M1-SPEC §11.2). */
export const MAX_SAFE_MAGNITUDE = 2 ** 53;
/** A name no capability may use for a param: the capability tools add it themselves. */
export const RESERVED_PARAM_NAMES: readonly string[] = ['request_id'];

// ajv ships CommonJS; under NodeNext the default import is the module object in the type
// system, and the class at runtime (both Node and esbuild interop).
type AjvCtor = typeof _Ajv2020.default;
const Ajv2020: AjvCtor =
  ((_Ajv2020 as unknown as { default?: AjvCtor }).default ?? (_Ajv2020 as unknown as AjvCtor));

let compiled: ReturnType<InstanceType<AjvCtor>['compile']> | undefined;
function schemaValidator() {
  if (!compiled) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
    compiled = ajv.compile(schema);
  }
  return compiled;
}

/**
 * Compile a manifest pattern with RE2 (re2js), default flags: no lookaround, no
 * backreferences, `$` only at the end of the input. Throws when RE2 cannot compile it.
 * Match with {@link fullMatch}, never with a JavaScript RegExp.
 */
export function compilePattern(pattern: string): RE2JS {
  return RE2JS.compile(pattern);
}

/** Full-match semantics (Python `re2.fullmatch`): the whole value must match. */
export function fullMatch(re: RE2JS, value: string): boolean {
  return re.matches(value);
}

// A small cache: the same few patterns are checked on every call.
const patternCache = new Map<string, RE2JS>();
function cachedPattern(pattern: string): RE2JS {
  let re = patternCache.get(pattern);
  if (!re) {
    re = compilePattern(pattern);
    if (patternCache.size >= 256) patternCache.clear();
    patternCache.set(pattern, re);
  }
  return re;
}

/** True when `value` holds a UTF-16 surrogate that is not part of a pair. */
export function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/** Finite and within ±2^53 (M1-SPEC §11.2). */
function isSafeMagnitude(v: number): boolean {
  return Number.isFinite(v) && Math.abs(v) <= MAX_SAFE_MAGNITUDE;
}

/** Anchored means: starts with ^ and ends with a $ that is not escaped. */
export function isAnchored(pattern: string): boolean {
  if (!pattern.startsWith('^') || !pattern.endsWith('$')) return false;
  let backslashes = 0;
  for (let i = pattern.length - 2; i >= 0 && pattern[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 0;
}

/** Length in code points, as Python's len() counts a str. */
export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

function describeAjvErrors(errors: NonNullable<ReturnType<typeof schemaValidator>['errors']>): string[] {
  const out: string[] = [];
  for (const e of errors) {
    const where = e.instancePath || '(root)';
    let msg = `${where}: ${e.message ?? 'invalid'}`;
    if (e.keyword === 'additionalProperties' && e.params && 'additionalProperty' in e.params) {
      msg += ` (${String(e.params.additionalProperty)})`;
    }
    if (!out.includes(msg)) out.push(msg);
  }
  return out;
}

function checkParamDefault(capName: string, pname: string, p: Param): string | null {
  if (p.default === undefined) return null;
  const r = validateOne(pname, p, p.default);
  return r === null ? null : `${capName}.${pname}: default does not satisfy its own param (${r})`;
}

/** Validate an already-parsed manifest document. Throws ManifestError with every problem found. */
export function validateManifest(doc: unknown): Manifest {
  const validate = schemaValidator();
  if (!validate(doc)) {
    throw new ManifestError(describeAjvErrors(validate.errors ?? []));
  }
  const manifest = doc as Manifest;
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const cap of manifest.capabilities) {
    if (seen.has(cap.name)) problems.push(`duplicate capability name: ${cap.name}`);
    seen.add(cap.name);
    const required = new Set(cap.required ?? []);
    for (const [pname, p] of Object.entries(cap.params)) {
      if (RESERVED_PARAM_NAMES.includes(pname)) {
        problems.push(`${cap.name}.${pname}: ${pname} is a reserved name and may not be a param`);
        continue;
      }
      if (required.has(pname) && p.default !== undefined) {
        problems.push(`${cap.name}.${pname}: a required param may not declare a default`);
        continue;
      }
      if (p.type === 'string') {
        const pattern = p.pattern;
        if (codePointLength(pattern) > MAX_PATTERN_LENGTH) {
          problems.push(`${cap.name}.${pname}: pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
          continue;
        }
        if (hasLoneSurrogate(pattern)) {
          problems.push(`${cap.name}.${pname}: pattern contains a lone surrogate`);
          continue;
        }
        if (!isAnchored(pattern)) {
          problems.push(`${cap.name}.${pname}: pattern must be anchored with ^ and $`);
          continue;
        }
        try {
          compilePattern(pattern);
        } catch (err) {
          problems.push(`${cap.name}.${pname}: pattern does not compile in RE2 (${(err as Error).message.slice(0, 200)})`);
          continue;
        }
      }
      if (p.type === 'integer' || p.type === 'number') {
        const bad = (['min', 'max', 'default'] as const).find((k) => {
          const v = p[k];
          return v !== undefined && !isSafeMagnitude(v);
        });
        if (bad) {
          problems.push(`${cap.name}.${pname}: ${bad} must be finite and within ±2^53`);
          continue;
        }
        if (p.min > p.max) {
          problems.push(`${cap.name}.${pname}: min ${p.min} is greater than max ${p.max}`);
          continue;
        }
      }
      const d = checkParamDefault(cap.name, pname, p);
      if (d) problems.push(d);
    }
    for (const r of cap.required ?? []) {
      if (!Object.hasOwn(cap.params, r)) problems.push(`${cap.name}: required name ${r} is not a param`);
    }
  }
  if (problems.length > 0) throw new ManifestError(problems);
  return manifest;
}

export function parseManifest(text: string): Manifest {
  let doc: unknown;
  try {
    doc = parseYaml(text, { maxAliasCount: 50 });
  } catch (err) {
    throw new ManifestError([`not valid YAML: ${(err as Error).message}`]);
  }
  return validateManifest(doc);
}

export function loadManifest(path: string): Manifest {
  return parseManifest(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------------------
// Param validation (§3.5)

export type ParamsResult =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; param: string; detail: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Returns null when valid, else a short reason. */
function validateOne(name: string, p: Param, v: unknown): string | null {
  switch (p.type) {
    case 'enum':
      if (typeof v !== 'string') return `${name} must be a string`;
      if (!p.values.includes(v)) return `${name} must be one of ${p.values.join(', ')}`;
      return null;
    case 'string': {
      if (typeof v !== 'string') return `${name} must be a string`;
      if (hasLoneSurrogate(v)) return `${name} contains a lone surrogate`;
      if (codePointLength(v) > p.max_length) return `${name} is longer than ${p.max_length} characters`;
      let re: RE2JS;
      try {
        re = cachedPattern(p.pattern);
      } catch {
        return `${name} has a pattern that does not compile`;
      }
      if (!fullMatch(re, v)) return `${name} does not match its allowed pattern`;
      return null;
    }
    case 'integer':
      // 5 and 5.0 are the same JSON number; anything with a fractional part is not an integer.
      if (typeof v !== 'number' || !isSafeMagnitude(v) || !Number.isInteger(v)) return `${name} must be an integer`;
      if (v < p.min || v > p.max) return `${name} must be between ${p.min} and ${p.max}`;
      return null;
    case 'number':
      if (typeof v !== 'number' || !isSafeMagnitude(v)) return `${name} must be a finite number within ±2^53`;
      if (v < p.min || v > p.max) return `${name} must be between ${p.min} and ${p.max}`;
      return null;
    case 'boolean':
      if (typeof v !== 'boolean') return `${name} must be true or false`;
      return null;
    default:
      return `${name} has an unknown type`;
  }
}

/**
 * Validate call params against one capability: no unknown keys, types, enum values,
 * bounds (finite, within ±2^53), max_length in code points, no lone surrogates, RE2 pattern
 * full match, required present. Defaults are filled in.
 * The first failing param is named.
 */
export function validateParams(cap: Capability, params: unknown): ParamsResult {
  if (!isPlainObject(params)) return { ok: false, param: '(params)', detail: 'params must be an object' };
  for (const key of Object.keys(params)) {
    if (!Object.hasOwn(cap.params, key)) {
      return { ok: false, param: key, detail: `${key} is not a parameter of ${cap.name}` };
    }
  }
  const required = new Set(cap.required ?? []);
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(cap.params)) {
    if (Object.hasOwn(params, name)) {
      const reason = validateOne(name, p, params[name]);
      if (reason) return { ok: false, param: name, detail: reason };
      const v = params[name];
      // An integer is normalised to an integer (-0 becomes 0, as Python's int(-0.0) does).
      out[name] = p.type === 'integer' && Object.is(v, -0) ? 0 : v;
    } else if (required.has(name)) {
      return { ok: false, param: name, detail: `${name} is required` };
    } else if (p.default !== undefined) {
      out[name] = p.default;
    }
  }
  return { ok: true, params: out };
}

export function findCapability(manifest: Manifest, name: string): Capability | undefined {
  return manifest.capabilities.find((c) => c.name === name);
}
