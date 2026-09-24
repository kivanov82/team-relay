// The fallback approvals page (M8-SPEC §4), for a Claude Code that does not offer MCP
// elicitation: a local page with the console server's rules (M2-SPEC §4.4, §7.7).
//
// - Binds 127.0.0.1 on a random port; a request whose Host is not 127.0.0.1:<port> or
//   localhost:<port> is refused (DNS rebinding).
// - /api/* needs X-Approvals-Key equal to a per-launch key (32 random bytes, compared in
//   constant time): missing 401, wrong 403. The key reaches the browser only in the URL
//   fragment, through the private redirect file (console-open.ts), never in a process argument.
// - The one write, POST /api/approvals/{id} {"decision"}, also needs Content-Type:
//   application/json and Sec-Fetch-Site: same-origin. No CORS headers, ever.
// - The page and its script are served from here under a strict CSP; teammate text is put on
//   the page with textContent only.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ApprovalQueue } from './approvals.js';
import { choicesFor, draftBody, draftFits, showable, visibleEscapes } from './approvals-review.js';
import { neutraliseChannelTags } from './notify.js';

const BODY_LIMIT = 4096;

/** The console's policy (console-app.ts), repeated here so this page needs nothing else of it. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
const ID_RE = /^ap_[0-9a-f]{16}$/;

const HEADERS: Record<string, string> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

export const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Team relay: approvals</title><link rel="stylesheet" href="/approvals.css"></head>
<body><main><h1>Answers waiting for your approval</h1>
<p class="note">Teammates' text is shown as they wrote it. Nothing is sent or run until you decide; anything you leave is denied at its deadline.</p>
<div id="items"></div><p id="status" role="status"></p></main>
<script src="/approvals.js"></script></body></html>
`;

export const PAGE_CSS = `body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#faf9f6;color:#222}
main{max-width:760px;margin:0 auto;padding:24px 16px}h1{font-size:20px}
.note{color:#555}.item{background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;margin:16px 0}
pre{white-space:pre-wrap;word-break:break-word;background:#f3f1ec;padding:8px;border-radius:6px;max-height:420px;overflow:auto}
button{margin-right:8px;padding:6px 12px;border-radius:6px;border:1px solid #888;background:#fff;cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#1b1a19;color:#eee}.item{background:#262523;border-color:#444}pre{background:#302e2b}button{background:#333;color:#eee}}`;

export const PAGE_JS = `(function(){
var key=(location.hash.match(/k=([A-Za-z0-9_-]+)/)||[])[1]||'';
history.replaceState(null,'',location.pathname);
var items=document.getElementById('items'),status=document.getElementById('status');
function el(t,text){var e=document.createElement(t);if(text!==undefined)e.textContent=text;return e;}
function load(){fetch('/api/approvals',{headers:{'X-Approvals-Key':key}}).then(function(r){if(!r.ok)throw new Error(r.status);return r.json();}).then(render).catch(function(){status.textContent='Could not load the approvals (is the working session still running?).';});}
function decide(id,decision){fetch('/api/approvals/'+id,{method:'POST',headers:{'X-Approvals-Key':key,'Content-Type':'application/json'},body:JSON.stringify({decision:decision})}).then(function(r){status.textContent=r.ok?'Done.':'That item is no longer pending.';load();});}
function render(data){items.textContent='';if(!data.items.length){items.appendChild(el('p','Nothing is waiting.'));return;}
data.items.forEach(function(it){var box=el('div');box.className='item';
box.appendChild(el('p',it.heading));box.appendChild(el('pre',it.teammate_text));box.appendChild(el('p',it.ask));
if(it.detail){box.appendChild(el('pre',it.detail));}
it.choices.forEach(function(c){var b=el('button',c.title);b.addEventListener('click',function(){decide(it.id,c.const);});box.appendChild(b);});
items.appendChild(box);});}
load();setInterval(load,5000);})();
`;

export type PageItem = {
  id: string;
  heading: string;
  teammate_text: string;
  ask: string;
  detail: string | null;
  choices: Array<{ const: string; title: string }>;
  deadline: string;
};

/** What the page shows for each pending item (the full draft: a page can scroll). */
export function pageItems(queue: ApprovalQueue, member: string): PageItem[] {
  return queue.list().map((item) => {
    const ctx = item.ctx;
    const cap = ctx.kind === 'capability_call' && ctx.capability;
    const heading = cap ? `${ctx.asker} asked you to run ${ctx.capability!.name} with these params (teammate data):` : `${ctx.asker} asked (teammate text):`;
    const teammate = neutraliseChannelTags(cap ? JSON.stringify(ctx.capability!.params) : ctx.question);
    let ask: string;
    let detail: string | null = null;
    let choices = choicesFor(item);
    const politely = `"Decline politely" sends: "I couldn't answer this automatically; ${member} hasn't approved it."`;
    if (item.ask.type === 'permission') {
      ask = `Your automatic answerer wants to ${item.ask.action}. Allow lets it do this once, for this question only.`;
    } else if (item.ask.type === 'run') {
      ask = `This question waits for your approval before your automatic answerer works on it: ${item.ask.reason}. ${politely}`;
    } else {
      ask = `The drafted answer waits because: ${item.ask.reasons.join('; ')}. ${politely}`;
      const body = draftBody(item);
      // M8-SPEC §7 item 8: the page shows the whole draft, so it can be sent from here, but only
      // when it is shown exactly: a draft with characters that hide or reorder text is shown
      // with them escaped, and cannot be sent.
      if (showable(body)) {
        detail = body;
        if (!draftFits(item)) choices = [{ const: 'send', title: 'Send this answer' }, ...choices];
      } else {
        detail = `(Characters that cannot be shown as they are appear as \\u{…}; this draft cannot be sent from here.)\n\n${visibleEscapes(body)}`;
      }
    }
    return { id: item.id, heading, teammate_text: teammate, ask, detail, choices, deadline: new Date(item.deadline).toISOString() };
  });
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export class ApprovalsPage {
  private server: Server | null = null;
  private port = 0;
  readonly key: string;

  constructor(
    private readonly queue: ApprovalQueue,
    private readonly member: string,
    key: string = randomBytes(32).toString('base64url'),
  ) {
    this.key = key;
  }

  get url(): string | null {
    return this.server ? `http://127.0.0.1:${this.port}/#k=${this.key}` : null;
  }

  async start(): Promise<string> {
    if (this.server) return this.url!;
    const server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
    return this.url!;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  private send(res: ServerResponse, status: number, body: string, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { ...HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  private json(res: ServerResponse, status: number, value: unknown) {
    this.send(res, status, JSON.stringify(value));
  }

  private async body(req: IncomingMessage): Promise<string | null> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > BODY_LIMIT) return null;
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return this.json(res, 421, { error: 'wrong_host' });
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      if (req.method !== 'GET') return this.json(res, 405, { error: 'method_not_allowed' });
      if (path === '/') return this.send(res, 200, PAGE_HTML, 'text/html; charset=utf-8');
      if (path === '/approvals.js') return this.send(res, 200, PAGE_JS, 'text/javascript; charset=utf-8');
      if (path === '/approvals.css') return this.send(res, 200, PAGE_CSS, 'text/css; charset=utf-8');
      return this.json(res, 404, { error: 'not_found' });
    }
    const given = req.headers['x-approvals-key'];
    if (typeof given !== 'string' || given === '') return this.json(res, 401, { error: 'missing_key' });
    if (!timingSafeEqual(digest(given), digest(this.key))) return this.json(res, 403, { error: 'wrong_key' });
    if (req.method === 'GET' && path === '/api/approvals') {
      return this.json(res, 200, { items: pageItems(this.queue, this.member) });
    }
    const m = /^\/api\/approvals\/([^/]+)$/.exec(path);
    if (req.method === 'POST' && m) {
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return this.json(res, 415, { error: 'json_only' });
      if (req.headers['sec-fetch-site'] !== 'same-origin') return this.json(res, 403, { error: 'same_origin_only' });
      const id = m[1]!;
      if (!ID_RE.test(id)) return this.json(res, 404, { error: 'not_found' });
      const raw = await this.body(req);
      if (raw === null) return this.json(res, 413, { error: 'too_large' });
      let decision: unknown;
      try {
        decision = (JSON.parse(raw) as { decision?: unknown }).decision;
      } catch {
        return this.json(res, 400, { error: 'invalid_json' });
      }
      const item = this.queue.get(id);
      if (!item) return this.json(res, 404, { error: 'not_found' });
      const offered = pageItems(this.queue, this.member).find((p) => p.id === id)?.choices.map((c) => c.const) ?? [];
      if (typeof decision !== 'string' || !offered.includes(decision)) return this.json(res, 400, { error: 'invalid_decision' });
      if (!this.queue.decide(id, decision)) return this.json(res, 409, { error: 'not_pending' });
      return this.json(res, 200, { decided: decision });
    }
    return this.json(res, 404, { error: 'not_found' });
  }
}
