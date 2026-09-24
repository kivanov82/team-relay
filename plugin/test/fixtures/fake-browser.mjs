#!/usr/bin/env node
// A stand-in for the member's browser (TEAM_RELAY_OPEN_COMMAND), for the login tests and the
// e2e login scenario (M5-SPEC §2, §8). It is given the path of the private redirect file the
// plugin writes (never the URL itself), reads the sign-in URL out of it, and then walks the
// flow headlessly: it follows redirects by hand with a cookie jar (any Set-Cookie, whatever
// its attributes: this is a test client on 127.0.0.1), and when a page shows a form (the
// relay's team chooser), it submits it as the browser would with the preselected, or the
// first, team. It stops after the request to http://127.0.0.1:<port>/callback.
//
// FAKE_BROWSER_LOG (optional): a file to append one JSON line to: {argv, url, steps, done}.
// FAKE_BROWSER_MODE (optional): "ignore" does nothing (a browser that never opened);
// "wrong-state" goes to the callback with another state; "twice" repeats the callback.
// FAKE_BROWSER_TEAM (optional): the team to choose on the chooser page.
// FAKE_BROWSER_EMAIL (optional): the Google account to sign in as at a fake provider's
// consent page (any URL whose path ends in /authorize gets &email=<it>, which the relay's
// relay/tests/fake_oauth_app.py reads).

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

/** The form on a page: action, method and the fields a browser would send. */
function parseForm(html) {
  const form = /<form\b[^>]*>/i.exec(html);
  if (!form) return null;
  const inputs = [...html.matchAll(/<input\b[^>]*>/gi)].map((m) => m[0]);
  const fields = [];
  const radios = [];
  const wantTeam = process.env.FAKE_BROWSER_TEAM;
  for (const tag of inputs) {
    const type = (attr(tag, 'type') ?? 'text').toLowerCase();
    const name = attr(tag, 'name');
    const value = attr(tag, 'value') ?? '';
    if (!name) continue;
    if (type === 'radio') radios.push({ name, value, checked: /\bchecked\b/i.test(tag) });
    else if (type !== 'submit' && type !== 'button') fields.push([name, value]);
  }
  const radio = wantTeam ? radios.find((r) => r.value === wantTeam) : (radios.find((r) => r.checked) ?? radios[0]);
  if (radio) fields.push([radio.name, radio.value]);
  // The Continue button when it carries a name (a Cancel button is never pressed).
  for (const m of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)) {
    const name = attr(m[0], 'name');
    if (name && !/cancel/i.test(m[1]) && !/cancel/i.test(attr(m[0], 'value') ?? '')) {
      fields.push([name, attr(m[0], 'value') ?? '']);
      break;
    }
  }
  return { action: attr(form[0], 'action') ?? '', method: (attr(form[0], 'method') ?? 'GET').toUpperCase(), fields };
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
    const form = res.status === 200 ? parseForm(text) : null;
    if (!form) return log({ url: start, steps, done: false, page: text.slice(0, 300) });
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
