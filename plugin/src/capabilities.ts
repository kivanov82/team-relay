// The capability MCP server (M1-SPEC §8.3): one tool per capability this member runs for
// teammates. It is not a channel. Arguments are validated against the manifest, and the call
// is bound to a directed capability request at the relay (§11.10), before a runner starts; a
// runner is started without a shell, without caller arguments and with a minimal
// environment, and its output must be a JSON object (§11.11).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_TIMEOUT_SECONDS, loadManifest, validateParams, type Capability, type Param } from './manifest.js';
import { defaultManifestPath, exposedCapabilities, type ExposedCapability } from './exposed.js';
import { MEMBER_RE, REQUEST_ID_RE, relayClientFromEnv, type Me, type RelayClient } from './relay-client.js';
import { activeRunners, runCapability, type Progress } from './runner.js';
import { makeLogger } from './log.js';
import { canonicalJson, describeError, isPlainObject, toolError, type ToolResult } from './tool-util.js';

const log = makeLogger('capabilities');
const VERSION = '0.1.0';
const MAX_PROGRESS_EVENTS = 200;
const PROGRESS_FLUSH_MS = 10_000;

function paramSchema(p: Param): Record<string, unknown> {
  switch (p.type) {
    case 'enum':
      return { type: 'string', enum: p.values, description: p.description, ...(p.default !== undefined ? { default: p.default } : {}) };
    case 'string':
      // The pattern is RE2 (M1-SPEC §11.1) and only this server evaluates it; it is not put in
      // `pattern`, where a client would evaluate it with another regex engine and dialect.
      return {
        type: 'string',
        maxLength: p.max_length,
        description: `${p.description} Must fully match the RE2 pattern ${p.pattern}`,
        ...(p.default !== undefined ? { default: p.default } : {}),
      };
    case 'integer':
    case 'number':
      return {
        type: p.type,
        minimum: p.min,
        maximum: p.max,
        description: p.description,
        ...(p.default !== undefined ? { default: p.default } : {}),
      };
    case 'boolean':
      return { type: 'boolean', description: p.description, ...(p.default !== undefined ? { default: p.default } : {}) };
  }
}

function toolFor(cap: Capability) {
  const properties: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(cap.params)) properties[name] = paramSchema(p);
  properties.request_id = {
    type: 'string',
    pattern: REQUEST_ID_RE.source,
    description: 'The request_id of the capability_call this run answers.',
  };
  return {
    name: cap.name,
    description: `${cap.title}. ${cap.description} (${cap.environment} data; run only for a capability_call you have acknowledged, with exactly its params.)`,
    inputSchema: {
      type: 'object' as const,
      properties,
      required: [...(cap.required ?? []), 'request_id'],
      additionalProperties: false,
    },
  };
}

/** Recipient statuses a capability may still be run for (a late answer is still useful). */
const RUNNABLE_STATUSES = new Set(['pending', 'acked', 'no_response', 'timed_out']);

/**
 * M1-SPEC §11.10: the call must answer a directed capability request, for this capability,
 * with exactly these params (defaults filled), addressed to this member, not yet answered
 * and not expired. Returns null when bound, else why not. Read from the relay as this
 * member, so the answering Claude cannot be talked into running a capability for a
 * broadcast question, another capability's request or different params.
 */
async function bindingProblem(
  client: RelayClient,
  me: Me,
  capability: string,
  requestId: string,
  params: Record<string, unknown>,
): Promise<string | null> {
  let doc: Record<string, unknown>;
  try {
    const got = await client.getRequest(requestId);
    if (!isPlainObject(got)) return 'the relay did not return a request document';
    doc = got;
  } catch (err) {
    return `the request could not be read from the relay (${describeError(err)})`;
  }
  if (doc.request_id !== requestId) return 'the relay returned a different request';
  if (doc.kind !== 'capability') return 'the request is not a capability request';
  if (doc.broadcast !== false) return 'the request is a broadcast; capabilities run only for directed requests';
  const cap = doc.capability;
  if (!isPlainObject(cap) || cap.name !== capability) return `the request is not for ${capability}`;
  if (!isPlainObject(cap.params) || canonicalJson(cap.params) !== canonicalJson(params)) {
    return 'the params differ from the params of the request';
  }
  if (typeof doc.asker !== 'string' || !MEMBER_RE.test(doc.asker) || doc.asker === me.member) {
    return 'the request has no other member as its asker';
  }
  const recipients = doc.recipients;
  const mine = isPlainObject(recipients) && Object.hasOwn(recipients, me.member) ? recipients[me.member] : undefined;
  if (!isPlainObject(mine)) return `the request is not addressed to ${me.member}`;
  if (mine.status === 'answered') return 'the request has already been answered';
  if (typeof mine.status !== 'string' || !RUNNABLE_STATUSES.has(mine.status)) return 'the request is not in a runnable state';
  const expireAt = typeof doc.expire_at === 'string' ? Date.parse(doc.expire_at) : Number.NaN;
  if (!Number.isFinite(expireAt)) return 'the request has no expiry';
  if (expireAt <= Date.now()) return 'the request has expired';
  return null;
}

async function runTool(
  client: RelayClient,
  whoAmI: () => Promise<Me>,
  entry: ExposedCapability,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const { request_id: requestId, ...params } = args;
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    return toolError('request_id must look like rq_ followed by 32 lowercase hex characters');
  }
  const checked = validateParams(entry.capability, params);
  if (!checked.ok) return toolError(`invalid params: ${checked.detail}`);

  let me: Me;
  try {
    me = await whoAmI();
  } catch (err) {
    return toolError(`cannot verify the request: this member's identity is unknown (${describeError(err)}); the runner was not started`);
  }
  const unbound = await bindingProblem(client, me, entry.capability.name, requestId, checked.params);
  if (unbound) {
    log(`refused ${entry.capability.name} for ${requestId}: ${unbound}`);
    return toolError(`refused: ${unbound}. Run a capability only for a capability_call addressed to you, with exactly its params; the runner was not started.`);
  }

  // Progress goes to the relay's side surface, in order, best effort; never to a stream.
  let sent = 0;
  let chain: Promise<void> = Promise.resolve();
  const onProgress = (p: Progress) => {
    if (sent >= MAX_PROGRESS_EVENTS) return;
    sent++;
    chain = chain.then(() =>
      client.progress(requestId, p).then(
        () => undefined,
        (err: unknown) => log(`progress for ${requestId} not recorded: ${describeError(err)}`),
      ),
    );
  };

  const name = entry.capability.name;
  log(`running ${name} for ${requestId}`);
  const result = await runCapability({
    runner: entry.runner,
    capability: name,
    params: checked.params,
    requestId,
    timeoutSeconds: entry.capability.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
    parentEnv: process.env,
    onProgress,
    onStderr: (line) => log(`[${name}] ${line}`),
  });
  await Promise.race([chain, new Promise<void>((r) => setTimeout(r, PROGRESS_FLUSH_MS).unref())]);
  if (!result.ok) {
    log(`${name} for ${requestId} failed: ${result.error}`);
    return toolError(result.error);
  }
  return { content: [{ type: 'text', text: JSON.stringify(result.value) }] };
}

async function main(): Promise<void> {
  const env = process.env;
  let client: RelayClient;
  let exposed: ExposedCapability[];
  try {
    client = relayClientFromEnv(env);
    const manifest = loadManifest(env.MANIFEST_PATH || defaultManifestPath());
    const result = exposedCapabilities(manifest, env);
    for (const s of result.skipped) log(`capability ${s.name} not offered: ${s.reason}`);
    exposed = result.exposed;
  } catch (err) {
    log(`cannot start: ${describeError(err)}`);
    process.exit(1);
  }
  log(`offering: ${exposed.map((e) => e.capability.name).join(', ') || '(none)'}`);

  // Who this server runs as, read from the relay when first needed and kept once known (a
  // failure is not kept, so a relay that was down at the first call does not disable it).
  let identity: Me | undefined;
  const whoAmI = async (): Promise<Me> => {
    if (identity) return identity;
    const me = await client.me();
    if (me.team !== client.team || !MEMBER_RE.test(me.member)) throw new Error('the relay answered for a different team');
    identity = me;
    return me;
  };

  const byName = new Map(exposed.map((e) => [e.capability.name, e]));
  const tools = exposed.map((e) => toolFor(e.capability));

  const server = new Server({ name: 'capabilities', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const entry = byName.get(req.params.name);
    if (!entry) return toolError(`unknown capability: ${req.params.name}`);
    const args = req.params.arguments ?? {};
    if (!isPlainObject(args)) return toolError('arguments must be an object');
    try {
      return await runTool(client, whoAmI, entry, args);
    } catch (err) {
      return toolError(describeError(err));
    }
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    for (const kill of activeRunners) kill('SIGKILL');
    void server.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  log(`fatal: ${describeError(err)}`);
  process.exit(1);
});
