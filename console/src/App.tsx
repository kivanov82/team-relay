import { useMemo, useState } from 'react'

import { Activity } from '@/components/console/activity'
import { Agents } from '@/components/console/agents'
import { Header } from '@/components/console/header'
import { JoinPanel } from '@/components/console/join'
import { RequestSheet } from '@/components/console/request-sheet'
import { Expired, MissingKey, SessionExpired, UnreachableBanner } from '@/components/console/states'
import { mapMembers, TeamMap } from '@/components/console/team-map'
import { consoleKey, isHosted } from '@/api/key'
import { useActivity, useConnection, useDirectory, useMe } from '@/hooks/queries'
import { useNow } from '@/hooks/use-now'
import { sortedRequests } from '@/lib/activity'
import { effectiveRequest } from '@/lib/steps'

export function Console() {
  const me = useMe()
  const directory = useDirectory()
  const activity = useActivity()
  const conn = useConnection()
  const localNow = useNow()
  const [openId, setOpenId] = useState<string | null>(null)

  const now = localNow + (activity.data?.serverOffsetMs ?? 0)
  const sorted = useMemo(() => (activity.data ? sortedRequests(activity.data) : []), [activity.data])
  // Every view draws the effective status, by the server's clock (M2 §7.2): what the
  // relay's sweep would record at this moment, not what the feed last stored.
  const requests = useMemo(() => sorted.map((r) => effectiveRequest(r, now)), [sorted, now])
  const member = me.data?.member ?? null
  const teammates = directory.data?.members.filter((m) => m.member !== member) ?? []
  const members = member ? mapMembers(member, me.data?.teammates ?? [], directory.data?.members, now) : []
  const held = openId ? (activity.data?.byId[openId] ?? null) : null
  const selected = held ? effectiveRequest(held, now) : null

  if (conn.state === 'session_expired' || me.error?.kind === 'session_expired') return <SessionExpired />
  if (conn.state === 'unauthorized' || me.error?.kind === 'unauthorized') return <Expired />

  return (
    <div className="min-h-dvh">
      <Header />
      <main className="mx-auto flex max-w-[1440px] flex-col gap-4 px-3 py-4 sm:px-6 sm:py-5">
        {conn.state === 'unreachable' ? <UnreachableBanner conn={conn} /> : null}
        <JoinPanel />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
          <TeamMap members={members} requests={requests} stale={conn.state === 'unreachable'} />
          <Agents
            agents={teammates}
            loading={directory.isPending}
            now={now}
            statsComplete={directory.data?.stats_complete !== false}
            className="lg:max-h-[27rem]" />
        </div>
        <Activity requests={requests} me={member} now={now} loading={activity.isPending} onOpen={setOpenId} />
      </main>
      <RequestSheet req={selected} me={member} now={now} onClose={() => setOpenId(null)} />
    </div>
  )
}

export function App() {
  // Hosted behind IAP (M3 §4) no key is needed; locally the link's key is.
  if (consoleKey() === null && !isHosted()) return <MissingKey />
  return <Console />
}
