#!/usr/bin/env node
// A stand-in for the member's browser (TEAM_RELAY_OPEN_COMMAND), for the login tests and the
// e2e login scenario (M5-SPEC §2, §8). It is given the path of the private redirect file the
// plugin writes (never the URL itself), reads the sign-in URL out of it, and then walks the
// flow headlessly: it follows redirects by hand with a cookie jar (any Set-Cookie, whatever
// its attributes: this is a test client on 127.0.0.1), and when a page shows a form it presses
// one button of it as a browser would (only that button's own name and value are sent, to its
// `formaction` when it has one): on the relay's chooser (M5-SPEC §2, M9-SPEC §3, §7.2), Accept
// for an invitation it is told to accept, else Continue with the preselected (or the first)
// team; on the create page (an account on no team), Create team with the values it is given.
// It stops after the request to http://127.0.0.1:<port>/callback, or on a page where there is
// nothing it was told to press.
//
// FAKE_BROWSER_LOG (optional): a file to append one JSON line to: {argv, url, steps, done}.
// FAKE_BROWSER_MODE (optional): "ignore" does nothing (a browser that never opened);
// "wrong-state" goes to the callback with another state (the listener answers 404 and keeps
// waiting); "twice" repeats the callback.
// FAKE_BROWSER_TEAM (optional): the team to choose on the chooser page.
// FAKE_BROWSER_EMAIL (optional): the Google account to sign in as at a fake provider's
// consent page (any URL whose path ends in /authorize gets &email=<it>, which the relay's
// relay/tests/fake_oauth_app.py reads).
// FAKE_BROWSER_ACCEPT (optional): a team id (or "*" for any) whose invitation to accept on the
// chooser before continuing (M9-SPEC §7.2).
// FAKE_BROWSER_CREATE (optional): "<name>|<team id>|<member id>": create that team on the create
// page (or from the chooser's "Create a new team"), then continue with it (M9-SPEC §3).

import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const log = (entry) => {
  if (process.env.FAKE_BROWSER_LOG) appendFileSync(process.env.FAKE_BROWSER_LOG, `${JSON.stringify({ argv, ...entry })}\n`);
};

function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;|&apos;/g, "'");
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : null;
}

/** The buttons of a page's form: name, value, formaction and label. */
function buttonsOf(html) {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)].map((m) => ({
    name: attr(m[0], 'name'),
    value: attr(m[0], 'value') ?? '',
    formaction: attr(m[0], 'formaction'),
    label: m[1].replace(/<[^>]*>/g, '').trim(),
  }));
}

/**
 * The form on a page and the button to press: action, method and the fields a browser would
 * send; null when there is nothing this browser was told to press.
 */
function parseForm(html, accepted) {
  const form = /<form\b[^>]*>/i.exec(html);
  if (!form) return null;
  const inputs = [...html.matchAll(/<input\b[^>]*>/gi)].map((m) => m[0]);
  const fields = [];
  const radios = [];
  const wantTeam = process.env.FAKE_BROWSER_TEAM;
  const create = process.env.FAKE_BROWSER_CREATE ? process.env.FAKE_BROWSER_CREATE.split('|') : null;
  const accept = process.env.FAKE_BROWSER_ACCEPT;
  let createPage = false;
  for (const tag of inputs) {
    const type = (attr(tag, 'type') ?? 'text').toLowerCase();
    const name = attr(tag, 'name');
    const value = attr(tag, 'value') ?? '';
    if (!name) continue;
    if (type === 'radio') radios.push({ name, value, checked: /\bchecked\b/i.test(tag) });
    else if (type !== 'submit' && type !== 'button') {
      if (type === 'text' && name === 'name') createPage = true;
      fields.push([name, value]);
    }
  }
  const buttons = buttonsOf(html);
  const action = attr(form[0], 'action') ?? '';
  const method = (attr(form[0], 'method') ?? 'GET').toUpperCase();
  const press = (b, extra = fields) => ({ action: b.formaction ?? action, method, fields: b.name ? [...extra, [b.name, b.value]] : extra, pressed: b.label });

  // An invitation to accept (a browser sends only a checked radio, and the button's own pair).
  if (accept && !accepted.has('*')) {
    const b = buttons.find((x) => x.name === 'accept' && (accept === '*' || x.value === accept) && !accepted.has(x.value));
    if (b) {
      accepted.add(b.value);
      const checked = radios.filter((r) => r.checked).map((r) => [r.name, r.value]);
      return press(b, [...fields, ...checked]);
    }
  }
  // The create page: the values given, then Create team.
  if (createPage) {
    if (!create) return null;
    const [name, team, member] = create;
    const filled = fields.map(([k, v]) => [k, k === 'name' ? name : k === 'team' ? team : k === 'member' ? member : v]);
    const b = buttons.find((x) => x.name === 'action' && x.value === 'create');
    return b ? press(b, filled) : null;
  }
  // The chooser: Continue with the chosen, the preselected, or the first team.
  const radio = wantTeam ? radios.find((r) => r.value === wantTeam) : (radios.find((r) => r.checked) ?? radios[0]);
  const next = buttons.find((x) => x.name === 'action' && x.value === 'continue');
  if (radio && next) return press(next, [...fields, [radio.name, radio.value]]);
  // No team to continue with: "Create a new team", when told to create one.
  const fresh = buttons.find((x) => x.name === 'action' && x.value === 'new');
  if (create && fresh) return press(fresh);
  return null;
}

async function main() {
  const mode = process.env.FAKE_BROWSER_MODE ?? 'follow';
  const file = argv[0];
  const html = readFileSync(file, 'utf8');
  const m = /http-equiv="refresh" content="0;url=([^"]+)"/.exec(html);
  if (!m) throw new Error('no redirect in the file');
  const start = decodeEntities(m[1]);
  if (mode === 'ignore') return log({ url: start, steps: [], done: false });

  const jar = new Map();
  const steps = [];
  const accepted = new Set();
  let url = start;
  let method = 'GET';
  let body;
  let contentType;
  for (let i = 0; i < 20; i++) {
    const target = new URL(url);
    if (process.env.FAKE_BROWSER_EMAIL && target.pathname.endsWith('/authorize') && !target.searchParams.has('email')) {
      target.searchParams.set('email', process.env.FAKE_BROWSER_EMAIL);
    }
    const isCallback = target.hostname === '127.0.0.1' && target.pathname === '/callback';
    if (isCallback && mode === 'wrong-state') target.searchParams.set('state', 'x'.repeat(43));
    const headers = { Accept: 'text/html,application/json' };
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie && !isCallback) headers.Cookie = cookie;
    if (contentType) headers['Content-Type'] = contentType;
    if (method === 'POST') headers.Origin = `${target.protocol}//${target.host}`;
    const res = await fetch(target, { method, headers, body, redirect: 'manual' });
    steps.push({ method, url: `${target.origin}${target.pathname}`, status: res.status });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      if (/max-age=0/i.test(c) || v === '') jar.delete(k);
      else jar.set(k, v);
    }
    const text = await res.text();
    if (isCallback) {
      if (mode === 'twice') {
        const again = await fetch(target, { redirect: 'manual' }).then((r) => r.status).catch(() => 'refused');
        steps.push({ method: 'GET', url: `${target.origin}${target.pathname}`, status: again });
      }
      return log({ url: start, steps, done: res.status === 200 });
    }
    body = undefined;
    contentType = undefined;
    method = 'GET';
    if (res.status >= 300 && res.status < 400) {
      url = new URL(res.headers.get('location'), target).toString();
      continue;
    }
    const form = res.status === 200 ? parseForm(text, accepted) : null;
    if (!form) return log({ url: start, steps, done: false, page: text.slice(0, 300) });
    steps.at(-1).pressed = form.pressed;
    const params = new URLSearchParams(form.fields);
    url = new URL(form.action || target.pathname, target).toString();
    if (form.method === 'POST') {
      method = 'POST';
      body = params.toString();
      contentType = 'application/x-www-form-urlencoded';
    } else {
      const u = new URL(url);
      for (const [k, v] of params) u.searchParams.append(k, v);
      url = u.toString();
    }
  }
  log({ url: start, steps, done: false, page: 'too many steps' });
}

main().catch((err) => {
  log({ error: String(err?.message ?? err) });
  process.exitCode = 1;
});
