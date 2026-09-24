import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { setTransport } from '@/api/client'
import { setConsoleKey } from '@/api/key'
import type { ActivityRequest } from '@/api/types'
import { fixtureCapabilityDetail, fixtureRequests, FIXTURE_NOW, RQ } from '@/mock/fixtures'
import { MockRelay } from '@/mock/relay'
import { renderWithClient } from '@/test/render'
import { RequestSheet } from './request-sheet'

const NOW = Date.parse(FIXTURE_NOW)

function find(id: string): ActivityRequest {
  const r = fixtureRequests.find((x) => x.request_id === id)
  if (!r) throw new Error(id)
  return r
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('RequestSheet', () => {
  it('masks the question and the answer for a non-participant, and never asks for the side surface', () => {
    setConsoleKey('k'.repeat(32))
    const transport = vi.fn(async () => json({}))
    setTransport(transport)
    renderWithClient(<RequestSheet req={find(RQ.masked)} me="alice" now={NOW} onClose={() => {}} />)

    const dialog = screen.getByRole('dialog')
    const masked = within(dialog).getAllByText('Only participants can see this')
    // The question, and bob's answer.
    expect(masked).toHaveLength(2)
    // Metadata stays visible: who, the steps and the tools.
    expect(within(dialog).getByText(/From/)).toHaveTextContent('From carol to bob')
    expect(dialog.querySelector('[data-tool="Read"][data-status="ok"]')).not.toBeNull()
    expect(transport).not.toHaveBeenCalled()
  })

  it('masks a non-participant capability call’s params but shows its name and environment', () => {
    setConsoleKey('k'.repeat(32))
    setTransport(async () => json({}))
    renderWithClient(<RequestSheet req={find(RQ.maskedCapability)} me="alice" now={NOW} onClose={() => {}} />)

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getAllByText('production_db_count').length).toBeGreaterThan(0)
    expect(within(dialog).getByText('Production')).toBeInTheDocument()
    expect(within(dialog).getAllByText('Only participants can see this')).toHaveLength(2)
    expect(within(dialog).queryByText('dataset')).toBeNull()
  })

  it('shows a participant the question and the answer preview in full', () => {
    setConsoleKey('k'.repeat(32))
    setTransport(async () => json({ ...fixtureCapabilityDetail, progress: [] }))
    renderWithClient(<RequestSheet req={find(RQ.answered)} me="alice" now={NOW} onClose={() => {}} />)

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByText('Only participants can see this')).toBeNull()
    expect(within(dialog).getByText(/Where does the retry budget/)).toBeInTheDocument()
    expect(within(dialog).getByText(/INGEST_RETRY_BUDGET/)).toBeInTheDocument()
  })

  it('shows a capability call’s params, its tool with outcome and duration, and the progress notes', async () => {
    setConsoleKey('k'.repeat(32))
    const transport = vi.fn(async (path: string) => json(path.endsWith(RQ.capability) ? fixtureCapabilityDetail : {}, 200))
    setTransport(transport)
    renderWithClient(<RequestSheet req={find(RQ.capability)} me="alice" now={NOW} onClose={() => {}} />)

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('dataset').nextSibling).toHaveTextContent('orders')
    expect(within(dialog).getByText('limit').nextSibling).toHaveTextContent('20')
    const tool = dialog.querySelector('[data-tool="staging_db_query"]')
    expect(tool).toHaveTextContent('OK')
    expect(tool).toHaveTextContent('1.8 s')
    await waitFor(() => expect(within(dialog).getByText('Reading orders where status is failed')).toBeInTheDocument())
    expect(within(dialog).getByText('12 rows, summarising')).toBeInTheDocument()
    expect(transport).toHaveBeenCalledWith(`api/requests/${RQ.capability}`, expect.objectContaining({ method: 'GET' }))
  })

  it('lays out the timeline with the latency of each hop', () => {
    setConsoleKey('k'.repeat(32))
    setTransport(async () => json({ ...fixtureCapabilityDetail, progress: [] }))
    renderWithClient(<RequestSheet req={find(RQ.answered)} me="alice" now={NOW} onClose={() => {}} />)

    const dialog = screen.getByRole('dialog')
    const delivered = dialog.querySelector('li[data-step="delivered"]')
    expect(delivered).toHaveTextContent('+640 ms')
    expect(dialog.querySelector('li[data-step="answered"]')).toHaveTextContent('+28 s')
    expect(dialog.querySelector('li[data-step="returned"]')).toHaveTextContent('+750 ms')
  })

  it('marks where a timed-out exchange stopped and the tool that failed', () => {
    setConsoleKey('k'.repeat(32))
    setTransport(async () => json({ ...fixtureCapabilityDetail, progress: [] }))
    renderWithClient(<RequestSheet req={find(RQ.timedOut)} me="alice" now={NOW} onClose={() => {}} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('li[data-step="answered"]')).toHaveAttribute('data-state', 'failed')
    expect(dialog.querySelector('[data-tool="Read"]')).toHaveAttribute('data-status', 'error')
    expect(dialog.querySelector('[data-tool="Read"]')).toHaveTextContent('Error')
  })

  it('tells a broadcast co-recipient that only the asker sees another recipient’s answer', () => {
    setConsoleKey('k'.repeat(32))
    setTransport(async () => json({ ...fixtureCapabilityDetail, recipients: {}, progress: [] }))
    // bob asks alice and carol; both have answered 60 s into the mock's first round.
    let t = NOW
    const relay = new MockRelay(() => t, 'alice')
    t = NOW + 60_000
    const req = relay.activity(null, 200).requests.find((r) => r.asker === 'bob' && r.broadcast)!
    expect(req.recipients.carol?.answer_preview).toBeNull()
    renderWithClient(<RequestSheet req={req} me="alice" now={t} onClose={() => {}} />)

    const dialog = screen.getByRole('dialog')
    const carol = dialog.querySelector('[data-recipient-detail="carol"]') as HTMLElement
    expect(within(carol).getByText('Only the asker sees this answer')).toBeInTheDocument()
    expect(within(carol).queryByText('No answer yet.')).toBeNull()
    const alice = dialog.querySelector('[data-recipient-detail="alice"]') as HTMLElement
    expect(within(alice).getByText(/rebased onto the new key/)).toBeInTheDocument()
    // The question itself is the participant's to read.
    expect(within(dialog).queryByText('Only participants can see this')).toBeNull()
  })

  it('still says no answer yet when an answer the viewer may read has no preview', () => {
    setConsoleKey('k'.repeat(32))
    setTransport(async () => json({ ...fixtureCapabilityDetail, progress: [] }))
    const req = structuredClone(find(RQ.answered))
    req.recipients.bob!.answer_preview = null // an answer recorded before previews existed
    renderWithClient(<RequestSheet req={req} me="alice" now={NOW} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('No answer yet.')).toBeInTheDocument()
    expect(within(dialog).queryByText('Only the asker sees this answer')).toBeNull()
  })
})
