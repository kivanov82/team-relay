// Pending team invitations (M9-SPEC §7.2) for whoami and the SessionStart line. The relay
// lists them on GET /v1/me/teams, which takes a Google identity only: a session signed in with
// a stored device credential (the usual case) or a static token cannot read them, and says
// nothing. Only ids reach the session (team ids and the inviter's member id, each checked
// against its pattern); a team's display name is someone else's text and is left out.

import { MEMBER_RE, TEAM_RE, type RelayClient } from './relay-client.js';

export type PendingInvitation = { team: string; invited_by: string | null };

/** The account's open invitations, or null when they cannot be read (bound sign-in, refused, unreachable). */
export async function readInvitations(client: RelayClient, timeoutMs = 3000): Promise<PendingInvitation[] | null> {
  if (client.boundToTeam) return null;
  try {
    const r = await client.myTeams({ attempts: 1, timeoutMs });
    const list = Array.isArray(r?.invitations) ? r.invitations : [];
    return list
      .filter((i): i is NonNullable<typeof i> => !!i && typeof i === 'object' && typeof i.team === 'string' && TEAM_RE.test(i.team))
      .slice(0, 20)
      .map((i) => ({ team: i.team, invited_by: typeof i.invited_by_member === 'string' && MEMBER_RE.test(i.invited_by_member) ? i.invited_by_member : null }));
  } catch {
    return null;
  }
}

/** One sentence about them, or null when there are none. */
export function invitationsSentence(list: PendingInvitation[] | null): string | null {
  if (!list || list.length === 0) return null;
  const how = 'accept it on the sign-in page (/team-relay:login lists it) or in the team console';
  if (list.length === 1) {
    const i = list[0]!;
    return `You have an invitation to team ${i.team}${i.invited_by ? ` from ${i.invited_by}` : ''}: ${how}.`;
  }
  return `You have ${list.length} team invitations (${list.map((i) => i.team).join(', ')}): ${how.replace('accept it', 'accept them').replace('lists it', 'lists them')}.`;
}

/** The whoami fields: the ids and the sentence; empty when there are none or they cannot be read. */
export async function invitationFields(client: RelayClient): Promise<Record<string, unknown>> {
  const list = await readInvitations(client);
  const sentence = invitationsSentence(list);
  if (!list || !sentence) return {};
  return { invitations: list.map((i) => i.team), invitations_notice: sentence };
}
