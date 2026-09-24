import { QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'

import { TooltipProvider } from '@/components/ui/tooltip'
import { createQueryClient } from '@/hooks/queries'

export function renderWithClient(ui: ReactElement) {
  const client = createQueryClient()
  const result = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  )
  return { client, ...result }
}

/** Sets document.hidden / visibilityState the way a backgrounded tab reports them. */
export function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('visibilitychange'))
}
