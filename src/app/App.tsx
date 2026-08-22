import { useCallback, useEffect, useState } from 'react'
import { HomePage } from './HomePage.tsx'
import { PlayerPage } from '../features/player/PlayerPage.tsx'
import { StudioPage } from '../features/studio/StudioPage.tsx'
import { LangProvider, LanguageSwitcher, useT } from '../i18n/index.tsx'
import { AboutFooter } from './AboutFooter.tsx'

/**
 * Hash tabanlı basit yönlendirme.
 *
 * Router kütüphanesi eklemiyoruz: üç ekran var ve hash yönlendirme statik
 * hosting'de (Cloudflare Pages) sunucu tarafı yeniden yazma kuralı gerektirmiyor.
 */
export type Route =
  | { name: 'home' }
  | { name: 'play'; packId: string; local: boolean; project: boolean }
  | { name: 'studio'; packId?: string; local?: boolean; project?: boolean }

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const [name, ...rest] = raw.split('/')
  const params = new URLSearchParams(rest[1] ?? '')
  const id = rest[0] ? decodeURIComponent(rest[0]) : undefined

  if (name === 'oyna' && id) {
    return { name: 'play', packId: id, local: params.get('y') === '1', project: params.get('p') === '1' }
  }
  if (name === 'studyo') {
    return { name: 'studio', packId: id, local: params.get('y') === '1', project: params.get('p') === '1' }
  }
  return { name: 'home' }
}

export function routeToHash(route: Route): string {
  if (route.name === 'play') {
    const q = `${route.local ? 'y=1' : ''}${route.project ? (route.local ? '&' : '') + 'p=1' : ''}`
    return `#/oyna/${encodeURIComponent(route.packId)}${q ? `/${q}` : ''}`
  }
  if (route.name === 'studio') {
    if (!route.packId) return '#/studyo'
    const q = `${route.local ? 'y=1' : ''}${route.project ? (route.local ? '&' : '') + 'p=1' : ''}`
    return `#/studyo/${encodeURIComponent(route.packId)}${q ? `/${q}` : ''}`
  }
  return '#/'
}

function Shell() {
  const t = useT()
  const [route, setRoute] = useState<Route>(parseHash)

  useEffect(() => {
    const onChange = () => setRoute(parseHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const go = useCallback((next: Route) => {
    window.location.hash = routeToHash(next)
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/" aria-label={t('nav.home')}>
          <span className="brand-dot" aria-hidden="true" />
          {t('app.name')}
        </a>
        <nav>
          <a className="navlink" href="#/" aria-current={route.name === 'home'}>
            {t('nav.packs')}
          </a>
          <a className="navlink" href="#/studyo" aria-current={route.name === 'studio'}>
            {t('nav.own')}
          </a>
          <LanguageSwitcher />
        </nav>
      </header>

      <main className="page">
        {route.name === 'home' && <HomePage onOpen={go} />}
        {route.name === 'play' && (
          <PlayerPage
            packId={route.packId}
            local={route.local}
            project={route.project}
            onNavigate={go}
          />
        )}
        {route.name === 'studio' && (
          <StudioPage
            packId={route.packId}
            local={route.local ?? false}
            project={route.project ?? false}
            onNavigate={go}
          />
        )}
      </main>

      <AboutFooter />
    </div>
  )
}

export function App() {
  return (
    <LangProvider>
      <Shell />
    </LangProvider>
  )
}
