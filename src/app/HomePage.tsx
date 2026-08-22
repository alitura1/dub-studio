import { useEffect, useState } from 'react'
import type { Route } from './App.tsx'
import { loadPackIndex, loadProjectIndex, type PackSource } from '../lib/packs.ts'
import { useT } from '../i18n/index.tsx'

export function HomePage({ onOpen }: { onOpen: (route: Route) => void }) {
  const t = useT()
  const [packs, setPacks] = useState<PackSource[] | null>(null)
  const [projects, setProjects] = useState<PackSource[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    Promise.all([loadPackIndex(), loadProjectIndex()])
      .then(([p, mine]) => {
        if (!alive) return
        setPacks(p)
        setProjects(mine)
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [])

  return (
    <>
      <section className="hero">
        <h1>{t('app.tagline')}</h1>
        <p>{t('app.intro')}</p>
      </section>

      {error && <div className="notice notice-bad">{t('home.loadError', { error })}</div>}

      <div className="section-head">
        <h2>{t('home.readyPacks')}</h2>
        {packs && <span className="faint">{t('home.packCount', { count: packs.length })}</span>}
      </div>

      {packs === null ? (
        <div className="row">
          <span className="spinner" aria-hidden="true" />
          <span className="muted">{t('home.loading')}</span>
        </div>
      ) : packs.length === 0 ? (
        <div className="empty">
          {t('home.noPacks')}
          <br />
          <code className="mono">npm run paket -- &lt;url&gt; --bas 1:12 --sure 20 --ad "Başlık" --yerel</code>
          <br />
          {t('home.noPacksHint')}
        </div>
      ) : (
        <div className="pack-grid">
          {packs.map(({ entry }) => (
            <button
              key={entry.dir}
              className="pack-card"
              onClick={() => onOpen({ name: 'play', packId: entry.id, local: !!entry.local, project: false })}
            >
              <strong>{entry.title}</strong>
              <span className="meta">
                <span>{t('home.seconds', { n: Math.round(entry.durationMs / 1000) })}</span>
                <span>{t('home.lines', { n: entry.lineCount })}</span>
              </span>
              {entry.local && <span className="badge">{t('home.local')}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="section-head">
        <h2>{t('home.yourProjects')}</h2>
        <a className="navlink" href="#/studyo">
          {t('home.addVideo')}
        </a>
      </div>

      {projects.length === 0 ? (
        <div className="empty">
          {t('home.noProjects')}
        </div>
      ) : (
        <div className="pack-grid">
          {projects.map(({ entry }) => (
            <button
              key={entry.id}
              className="pack-card"
              onClick={() => onOpen({ name: 'play', packId: entry.id, local: false, project: true })}
            >
              <strong>{entry.title}</strong>
              <span className="meta">
                <span>{t('home.seconds', { n: Math.round(entry.durationMs / 1000) })}</span>
                <span>{t('home.lines', { n: entry.lineCount })}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}
