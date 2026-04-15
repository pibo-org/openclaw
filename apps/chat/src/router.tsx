import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { getConfiguredChatBasePath } from './lib/base-path'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const router = createTanStackRouter({
    basepath: getConfiguredChatBasePath() || '/',
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
