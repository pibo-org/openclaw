import { ClientOnly } from '@tanstack/react-router'
import { App } from '#/app'

function LoadingChat() {
  return (
    <div className="grid min-h-[60vh] place-items-center rounded-[2rem] border border-white/10 bg-black/20 px-6 py-12 text-sm text-slate-300">
      Chat-Oberflaeche wird geladen...
    </div>
  )
}

export function ChatAppClient({ gatewayBootstrapToken }: { gatewayBootstrapToken: string | null }) {
  return (
    <ClientOnly fallback={<LoadingChat />}>
      <App initialGatewayBootstrapToken={gatewayBootstrapToken} />
    </ClientOnly>
  )
}
