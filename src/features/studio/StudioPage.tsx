import { useCallback, useEffect, useRef, useState } from 'react'
import type { Route } from '../../app/App.tsx'
import {
  CHARACTER_COLORS,
  PACK_SCHEMA_VERSION,
  slugify,
  type Pack,
  type PackLine,
} from '../../lib/pack.ts'
import { ANALYSIS_RATE } from '../../lib/audio/resample.ts'
import { decodeAudio, toAnalysisPcm } from '../../lib/audio/context.ts'
import { segmentLines } from '../../lib/audio/segment.ts'
import { deleteProject, loadProject, saveProject } from '../../lib/store.ts'
import { fetchPack } from '../../lib/packs.ts'
import { Waveform } from './Waveform.tsx'
import { TranscribePanel } from '../transcribe/TranscribePanel.tsx'
import { useT } from '../../i18n/index.tsx'

const MAX_BYTES = 500 * 1024 * 1024
const MAX_MS = 10 * 60 * 1000
/**
 * Bu sürenin üstünde uyarı gösteriyoruz.
 * Düzenleme tarafı uzun kliplerde de akıcı, ama dışa aktarma tüm sesi
 * OfflineAudioContext'te üretip ffmpeg.wasm'a veriyor: 10 dakikalık stereo
 * miks tek başına ~230 MB. Sınırı engel yapmak yerine, nerede zorlanacağını
 * önceden söylemek daha doğru.
 */
const HEAVY_MS = 5 * 60 * 1000

interface Props {
  packId?: string
  local: boolean
  project: boolean
  onNavigate: (route: Route) => void
}

interface Loaded {
  pack: Pack
  videoUrl: string
  videoBlob: Blob | null
  pcm: Float32Array
  /** Hazır paketler düzenlenebilir ama kaydetmek onları projeye kopyalar. */
  readOnlySource: boolean
}

export function StudioPage({ packId, local, project, onNavigate }: Props) {
  const t = useT()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [playheadMs, setPlayheadMs] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [saved, setSaved] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const rafRef = useRef<number | null>(null)
  const urlRef = useRef<string | null>(null)

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Mevcut bir paketi düzenlemeye açma
  useEffect(() => {
    if (!packId) return
    let alive = true
    setError(null)
    setStatus(t('studio.loadingPack'))
    ;(async () => {
      if (project) {
        const stored = await loadProject(packId)
        if (!stored) throw new Error(t('studio.projectMissing'))
        const url = URL.createObjectURL(stored.video)
        urlRef.current = url
        const pcm = toAnalysisPcm(await decodeAudio(await stored.video.arrayBuffer()))
        return { pack: stored.pack, videoUrl: url, videoBlob: stored.video, pcm, readOnlySource: false }
      }
      const base = `${import.meta.env.BASE_URL}packs/${local ? 'yerel/' : ''}${packId}/`
      const pack = await fetchPack(base)
      const res = await fetch(base + pack.video)
      if (!res.ok) throw new Error(t('studio.videoLoadFailed', { status: res.status }))
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      const pcm = toAnalysisPcm(await decodeAudio(await blob.arrayBuffer()))
      return { pack, videoUrl: url, videoBlob: blob, pcm, readOnlySource: true }
    })()
      .then((l) => {
        if (!alive) return
        setLoaded(l)
        setSelectedId(l.pack.lines[0]?.id ?? null)
        setStatus(null)
      })
      .catch((err) => {
        if (alive) {
          setError(err instanceof Error ? err.message : String(err))
          setStatus(null)
        }
      })
    return () => {
      alive = false
    }
  }, [packId, local, project, t])

  const ingestFile = useCallback(async (file: File) => {
    setError(null)
    setSaved(false)
    if (file.size > MAX_BYTES) {
      setError(t('studio.tooBig', { mb: (file.size / 1024 / 1024).toFixed(0) }))
      return
    }
    setStatus(t('studio.decoding'))
    try {
      const bytes = await file.arrayBuffer()
      const buffer = await decodeAudio(bytes)
      if (buffer.duration * 1000 > MAX_MS) {
        setError(t('studio.tooLong'))
        setStatus(null)
        return
      }
      const pcm = toAnalysisPcm(buffer)

      setStatus(t('studio.findingLines'))
      const ranges = segmentLines(pcm, { sampleRate: ANALYSIS_RATE })
      const durationMs = Math.round(buffer.duration * 1000)

      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      const url = URL.createObjectURL(file)
      urlRef.current = url

      const title = file.name.replace(/\.[^.]+$/, '')
      const pack: Pack = {
        schemaVersion: PACK_SCHEMA_VERSION,
        id: `proje-${slugify(title)}-${Date.now().toString(36)}`,
        title,
        video: file.name,
        reference: '',
        durationMs,
        characters: [{ id: 'k1', name: t('studio.characterN', { n: 1 }), color: CHARACTER_COLORS[0] }],
        lines: ranges.map((r, i) => ({
          id: `l${i + 1}`,
          characterId: 'k1',
          startMs: Math.round(r.startMs),
          endMs: Math.round(r.endMs),
          text: '',
          leadInMs: 800,
        })),
        source: { kind: 'file', ref: file.name },
      }

      setLoaded({ pack, videoUrl: url, videoBlob: file, pcm, readOnlySource: false })
      setSelectedId(pack.lines[0]?.id ?? null)
      const found =
        ranges.length > 0 ? t('studio.foundLines', { n: ranges.length }) : t('studio.noLinesFound')
      setStatus(durationMs > HEAVY_MS ? `${found} ${t('studio.heavyWarning')}` : found)
    } catch (err) {
      console.error(err)
      setError(t('studio.unreadable'))
      setStatus(null)
    }
  }, [t])

  const updateLine = useCallback((lineId: string, patch: Partial<PackLine>) => {
    setSaved(false)
    setLoaded((prev) =>
      prev
        ? {
            ...prev,
            pack: {
              ...prev.pack,
              lines: prev.pack.lines
                .map((l) => (l.id === lineId ? { ...l, ...patch } : l))
                .sort((a, b) => a.startMs - b.startMs),
            },
          }
        : prev,
    )
  }, [])

  const addLine = useCallback(() => {
    setLoaded((prev) => {
      if (!prev) return prev
      const startMs = Math.min(prev.pack.durationMs - 1000, Math.round(playheadMs))
      const line: PackLine = {
        id: `l${Date.now().toString(36)}`,
        characterId: prev.pack.characters[0].id,
        startMs,
        endMs: Math.min(prev.pack.durationMs, startMs + 1500),
        text: '',
        leadInMs: 800,
      }
      setSelectedId(line.id)
      setSaved(false)
      return { ...prev, pack: { ...prev.pack, lines: [...prev.pack.lines, line].sort((a, b) => a.startMs - b.startMs) } }
    })
  }, [playheadMs])

  const removeLine = useCallback((lineId: string) => {
    setSaved(false)
    setLoaded((prev) =>
      prev ? { ...prev, pack: { ...prev.pack, lines: prev.pack.lines.filter((l) => l.id !== lineId) } } : prev,
    )
  }, [])

  const addCharacter = useCallback(() => {
    setLoaded((prev) => {
      if (!prev) return prev
      const i = prev.pack.characters.length
      return {
        ...prev,
        pack: {
          ...prev.pack,
          characters: [
            ...prev.pack.characters,
            {
              id: `k${i + 1}`,
              name: t('studio.characterN', { n: i + 1 }),
              color: CHARACTER_COLORS[i % CHARACTER_COLORS.length],
            },
          ],
        },
      }
    })
  }, [t])

  const save = useCallback(async () => {
    if (!loaded?.videoBlob) return
    setStatus(t('studio.saving'))
    try {
      // Hazır paketi düzenlediysek kaynağı bozmuyoruz; kopyası proje olarak kaydediliyor
      const id = loaded.readOnlySource ? `proje-${loaded.pack.id}-${Date.now().toString(36)}` : loaded.pack.id
      const pack = { ...loaded.pack, id }
      await saveProject({ id, pack, video: loaded.videoBlob, updatedAt: Date.now() })
      setLoaded({ ...loaded, pack, readOnlySource: false })
      setSaved(true)
      setStatus(t('studio.savedMsg'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus(null)
    }
  }, [loaded, t])

  const seek = useCallback((ms: number) => {
    setPlayheadMs(ms)
    if (videoRef.current) videoRef.current.currentTime = ms / 1000
  }, [])

  const playRange = useCallback((line: PackLine) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = line.startMs / 1000
    void video.play()
    const tick = () => {
      if (!videoRef.current) return
      const t = videoRef.current.currentTime * 1000
      setPlayheadMs(t)
      if (t >= line.endMs) {
        videoRef.current.pause()
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const pack = loaded?.pack

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <a className="btn btn-ghost btn-sm" href="#/">
          {t('player.back')}
        </a>
        <h1 style={{ fontSize: 20 }}>{pack ? pack.title : t('studio.title')}</h1>
        {loaded && (
          <div className="row" style={{ marginLeft: 'auto' }}>
            <button className="btn btn-sm" onClick={save} disabled={!loaded.videoBlob}>
              {saved ? t('studio.saved') : t('studio.save')}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={async () => {
                await save()
                onNavigate({ name: 'play', packId: loaded.pack.id, local: false, project: true })
              }}
              disabled={!loaded.videoBlob || loaded.pack.lines.length === 0}
            >
              {t('studio.toDubbing')}
            </button>
          </div>
        )}
      </div>

      {error && <div className="notice notice-bad" style={{ marginBottom: 12 }}>{error}</div>}
      {status && <div className="notice" style={{ marginBottom: 12 }}>{status}</div>}

      {!loaded ? (
        <label
          className="drop"
          data-over={dragOver}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            const file = e.dataTransfer.files[0]
            if (file) void ingestFile(file)
          }}
        >
          <strong style={{ fontSize: 17 }}>{t('studio.dropTitle')}</strong>
          <span className="muted">
            {t('studio.dropHint')}
            <br />
            {t('studio.dropPrivacy')}
          </span>
          <input
            type="file"
            accept="video/mp4,video/*"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void ingestFile(file)
            }}
          />
        </label>
      ) : (
        <div className="stack">
          <div className="studio-layout">
            <div>
              <div className="stage">
                <video
                  ref={videoRef}
                  src={loaded.videoUrl}
                  playsInline
                  controls
                  onTimeUpdate={(e) => setPlayheadMs(e.currentTarget.currentTime * 1000)}
                />
              </div>

              <Waveform
                pcm={loaded.pcm}
                durationMs={loaded.pack.durationMs}
                lines={loaded.pack.lines}
                characters={loaded.pack.characters}
                selectedId={selectedId}
                playheadMs={playheadMs}
                onSelect={setSelectedId}
                onChange={(id, startMs, endMs) => updateLine(id, { startMs: Math.round(startMs), endMs: Math.round(endMs) })}
                onSeek={seek}
              />
              <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
                {t('studio.waveHint')}
              </div>
            </div>

            <div className="card script">
              <div className="script-head">
                <strong>{t('studio.lines')}</strong>
                <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={addLine}>
                  {t('studio.addLine')}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={addCharacter}>
                  {t('studio.addCharacter')}
                </button>
              </div>
              <div className="script-list">
                {loaded.pack.lines.length === 0 && (
                  <div className="empty" style={{ margin: 8 }}>
                    {t('studio.noLines')}
                  </div>
                )}
                {loaded.pack.lines.map((line, i) => (
                  <div key={line.id} className="editor-line" aria-selected={selectedId === line.id}>
                    <select
                      value={line.characterId}
                      onChange={(e) => updateLine(line.id, { characterId: e.target.value })}
                      aria-label={t('studio.character')}
                      style={{ maxWidth: 110 }}
                    >
                      {loaded.pack.characters.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={line.text}
                      placeholder={t('studio.linePlaceholder', { n: i + 1 })}
                      onFocus={() => setSelectedId(line.id)}
                      onChange={(e) => updateLine(line.id, { text: e.target.value })}
                    />
                    <div className="row" style={{ gap: 4 }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => playRange(line)} title={t('studio.playRange')}>
                        ▷
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => removeLine(line.id)} title={t('studio.deleteLine')}>
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <TranscribePanel
            pack={loaded.pack}
            pcm={loaded.pcm}
            onApply={(lines) => {
              setSaved(false)
              setLoaded((prev) => (prev ? { ...prev, pack: { ...prev.pack, lines } } : prev))
              setSelectedId(lines[0]?.id ?? null)
              setStatus(t('studio.linesUpdated', { n: lines.length }))
            }}
          />

          {project && packId && (
            <div className="row">
              <button
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  await deleteProject(packId)
                  onNavigate({ name: 'home' })
                }}
              >
                {t('studio.deleteProject')}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  )
}
