import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '@/index.css'
import { setConsoleKey, takeKeyFromLocation } from '@/api/key'
import { setTransport } from '@/api/client'
import { App } from '@/App'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createQueryClient } from '@/hooks/queries'
import { applyTheme } from '@/hooks/use-theme'

async function start() {
  applyTheme()

  // Dev only: `VITE_MOCK=1 pnpm dev`, or `?mock` on the dev server, serves the scripted
  // synthetic team from src/mock instead of the console server. The production build drops
  // this branch and the mock module entirely (import.meta.env.DEV is false there).
  const params = new URLSearchParams(window.location.search)
  if (import.meta.env.DEV && (import.meta.env.VITE_MOCK === '1' || params.has('mock'))) {
    const { MockRelay } = await import('@/mock/relay')
    const relay = new MockRelay()
    relay.reachable = params.get('mock') !== 'down'
    relay.rateLimited = params.get('mock') === 'slow'
    setTransport((path) => relay.handle(path))
    setConsoleKey('mock-console-key-0000000000000000')
    Object.assign(window, { __mockRelay: relay })
  } else {
    takeKeyFromLocation()
  }

  const root = document.getElementById('root')
  if (!root) return
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={createQueryClient()}>
        <TooltipProvider delayDuration={250}>
          <App />
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  )
}

void start()
