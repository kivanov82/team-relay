// `node dist/logout.js`: /team-relay:logout (M5-SPEC §9 item 2). Logout is a command the
// member runs, never a tool the model can call: nothing a teammate writes can sign them out.
//
// Revokes the stored device credential at the relay it was issued by (DELETE
// /v1/teams/{team}/credentials/self, sent once), then deletes the credential file. The
// credential only ever goes to its own relay, whatever RELAY_URL says. A file that must not
// be used (permissions, owner, content) is deleted without being sent anywhere: signing out
// must always be possible. A running working session notices the file is gone within 2 s
// and goes back to waiting for /team-relay:login.
//
// Prints one line on stdout. Exit 0: signed out, or not signed in; 1: the file could not be
// deleted. Never prints the credential.

import { CredentialFileError, credentialsPath, readCredential, removeCredential, type StoredCredential } from './credentials.js';
import { RelayClient, RelayError } from './relay-client.js';
import { describeError } from './tool-util.js';

export type LogoutOutcome = { exitCode: number; line: string };

export async function logout(env: NodeJS.ProcessEnv = process.env, opts: { timeoutMs?: number } = {}): Promise<LogoutOutcome> {
  let path: string;
  try {
    path = credentialsPath(env);
  } catch (err) {
    return { exitCode: 1, line: `team-relay: cannot sign out: ${describeError(err)}` };
  }
  const remove = (): string | null => {
    try {
      removeCredential(path);
      return null;
    } catch (err) {
      return describeError(err);
    }
  };

  let stored: StoredCredential | null;
  try {
    stored = readCredential(path);
  } catch (err) {
    const why = err instanceof CredentialFileError ? err.message : describeError(err);
    const failed = remove();
    if (failed) return { exitCode: 1, line: `team-relay: the stored sign-in cannot be used (${why}), and it could not be deleted: ${failed}` };
    return {
      exitCode: 0,
      line: `team-relay: signed out on this computer. The stored sign-in could not be used (${why}), so it was deleted here without asking the relay; it expires on its own.`,
    };
  }
  if (!stored) return { exitCode: 0, line: 'team-relay: not signed in on this computer; nothing to do.' };

  const who = `${stored.member}${stored.email ? ` (${stored.email})` : ''}`;
  let revoked: string;
  try {
    const credential = stored.credential;
    const client = new RelayClient({ url: stored.relay_url, team: stored.team, token: () => credential, attempts: 1, timeoutMs: opts.timeoutMs ?? 10_000 });
    await client.revokeSelf();
    revoked = 'The relay revoked this computer\'s credential';
  } catch (err) {
    if (err instanceof RelayError && (err.status === 401 || err.status === 404)) revoked = 'The relay no longer accepted this credential';
    else revoked = `The relay did not revoke it (${describeError(err)}), so the credential expires on its own`;
  }
  const failed = remove();
  if (failed) return { exitCode: 1, line: `team-relay: ${revoked}, but the credential file could not be deleted: ${failed}` };
  return { exitCode: 0, line: `team-relay: signed out of team ${stored.team} as ${who}. ${revoked}, and it was deleted here. Run /team-relay:login to sign in again.` };
}

if (process.argv[1] && /logout\.[jt]s$/.test(process.argv[1])) {
  if (process.argv.length > 2) {
    process.stderr.write('usage: logout.js (no arguments)\n');
    process.exitCode = 2;
  } else {
    void logout().then(
      ({ exitCode, line }) => {
        process.stdout.write(`${line}\n`);
        process.exitCode = exitCode;
      },
      (err: unknown) => {
        process.stdout.write(`team-relay: cannot sign out: ${describeError(err)}\n`);
        process.exitCode = 1;
      },
    );
  }
}
