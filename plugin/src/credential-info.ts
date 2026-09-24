// `node dist/credential-info.js`: what bin/answerer needs to know about the stored sign-in
// (M5-SPEC §6), from the one implementation of the credential file's rules (credentials.ts).
//
// Prints {"path", "relay_url", "team", "member"} as JSON on stdout and exits 0 when a usable
// credential is stored; exits 3 when there is none; exits 1 with the reason on stderr when a
// file is there but must not be used. Never prints the credential. With --default-relay it
// prints the plugin's default relay URL instead (empty when there is none).

import { CredentialFileError, credentialsPath, readCredential } from './credentials.js';
import { defaultRelayUrl } from './relay-default.js';

function main(): number {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--default-relay') {
    process.stdout.write(`${defaultRelayUrl() ?? ''}\n`);
    return 0;
  }
  if (args.length > 0) {
    process.stderr.write('usage: credential-info.js [--default-relay]\n');
    return 2;
  }
  let path: string;
  try {
    path = credentialsPath(process.env);
    const stored = readCredential(path);
    if (!stored) return 3;
    process.stdout.write(`${JSON.stringify({ path, relay_url: stored.relay_url, team: stored.team, member: stored.member })}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof CredentialFileError || err instanceof Error ? err.message : 'the credential file cannot be used'}\n`);
    return 1;
  }
}

process.exitCode = main();
