import { useCallback, useEffect, useRef, useState } from 'react'
import type { Route } from '../../app/App.tsx'
import { formatMs, type PackLine } from '../../lib/pack.ts'
import { ANALYSIS_RATE, resampleLinear, slicePcm } from '../../lib/audio/resample.ts'
import { audioContext, decodeAudio, resumeAudio } from '../../lib/audio/context.ts'
import { deleteTake, loadTakes, saveTake, type StoredTake } from '../../lib/store.ts'
import { scoreInWorker } from '../scoring/scoreClient.ts'
import { ScoreCard, scoreClass } from '../scoring/ScoreCard.tsx'
import { useRecorder } from '../recorder/useRecorder.ts'
import { usePackData } from './usePackData.ts'
import { ExportPanel } from '../export/ExportPanel.tsx'
import { envelopeColumns, LineWaveform, type LineWaveformHandle } from './LineWaveform.tsx'
import { buildCenterRemoved, type OriginalMode } from '../export/mix.ts'
import { useT } from '../../i18n/index.tsx'

/** Repliğin bitişinden sonra kayda devam edilen süre — son hece kesilmesin. */
const TAIL_MS = 350

/** Geri sayım vuruşu. 3 × 700 ms, hazırlanmaya yetiyor ama sıkmıyor. */
const BEAT_MS = 700
const BEATS = 3

type Phase = 'idle' | 'leadin' | 'recording' | 'processing'

interface Props {
  packId: string
  local: boolean
  project: boolean
  onNavigate: (route: Route) => void
}

export function PlayerPage({ packId, local, project, onNavigate }: Props) {
  const t = useT()
  const { data, error } = usePackData(packId, local, project)
  const recorder = useRecorder()

  const videoRef = useRef<HTMLVideoElement>(null)
  const rafRef = useRef<number | null>(null)
  const sessionRef = useRef<{
    line: PackLine
    marked: boolean
    /** İki yerden birden bitirilmeye çalışılmasın (rAF + zaman aşımı). */
    finishing: boolean
    deadline: ReturnType<typeof setTimeout> | null
    markTimer: ReturnType<typeof setTimeout> | null
  } | null>(null)

  const [takes, setTakes] = useState<Map<string, StoredTake[]>>(new Map())
  const [activeTakeIds, setActiveTakeIds] = useState<Record<string, string>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [countdown, setCountdown] = useState(0)
  const [cueProgress, setCueProgress] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  // Dışa aktarmayla aynı seçim: önizlemede duyduğun, indirdiğinde de o olsun
  const [originalMode, setOriginalMode] = useState<OriginalMode>('mute')

  /**
   * Videonun sesini Web Audio'dan geçiren düğümler.
   * `createMediaElementSource` bir eleman için yalnızca bir kez çağrılabildiği
   * ve çağrıldıktan sonra ses zorunlu olarak graftan aktığı için tembel kurup
   * saklıyoruz.
   */
  const graphRef = useRef<{ main: GainNode; side: GainNode } | null>(null)
  const waveRef = useRef<LineWaveformHandle>(null)
  /** Seçili take'in zarfı; kayıt bitince ve take değişince yeniden hesaplanıyor. */
  const [userEnvelope, setUserEnvelope] = useState<Float32Array | null>(null)

  const ensureGraph = useCallback(async () => {
    if (graphRef.current) return graphRef.current
    const video = videoRef.current
    if (!video) return null
    const ctx = audioContext()
    const source = ctx.createMediaElementSource(video)
    const main = ctx.createGain()
    source.connect(main).connect(ctx.destination)
    const side = ctx.createGain()
    side.gain.value = 0
    buildCenterRemoved(ctx, source).connect(side).connect(ctx.destination)
    graphRef.current = { main, side }
    return graphRef.current
  }, [])

  const pack = data?.pack
  const lines = pack?.lines ?? []
  const selected = lines.find((l) => l.id === selectedId) ?? lines[0] ?? null

  useEffect(() => {
    if (!pack) return
    setSelectedId((cur) => cur ?? pack.lines[0]?.id ?? null)
    loadTakes(pack.id).then((loaded) => {
      setTakes(loaded)
      // Varsayılan aktif take: en yüksek puanlı olan. Kullanıcı sonra değiştirebilir.
      const best: Record<string, string> = {}
      for (const [lineId, list] of loaded) {
        const winner = [...list].sort((a, b) => (b.score?.total ?? -1) - (a.score?.total ?? -1))[0]
        if (winner) best[lineId] = winner.takeId
      }
      setActiveTakeIds(best)
    })
  }, [pack])

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
  }, [])

  const activeTakeFor = useCallback(
    (lineId: string): StoredTake | null => {
      const list = takes.get(lineId)
      if (!list || list.length === 0) return null
      return list.find((t) => t.takeId === activeTakeIds[lineId]) ?? list[list.length - 1]
    },
    [takes, activeTakeIds],
  )

  /** Kaydı bitirir, hizalar, skorlar ve saklar. */
  const finishRecording = useCallback(
    async (line: PackLine) => {
      const session = sessionRef.current
      if (session) {
        if (session.finishing) return
        session.finishing = true
        if (session.deadline !== null) clearTimeout(session.deadline)
        if (session.markTimer !== null) clearTimeout(session.markTimer)
      }

      const video = videoRef.current
      video?.pause()
      if (video) video.muted = false
      stopLoop()
      setPhase('processing')
      setCountdown(0)
      setCueProgress(0)

      const result = await recorder.stop()
      sessionRef.current = null
      if (!result || !data) {
        setPhase('idle')
        return
      }

      try {
        // Ham PCM elimizde: sıkıştırılmış blob'u tekrar çözmeye gerek yok
        const pcm = resampleLinear(result.pcm, result.sampleRate, ANALYSIS_RATE)
        // Kayıt geri sayımdan sonra, replikten önce başladı: farkı baştan at
        const trimSamples = Math.round((result.leadTrimMs / 1000) * ANALYSIS_RATE)
        const aligned = pcm.subarray(Math.min(trimSamples, pcm.length))
        const ref = slicePcm(data.refPcm, ANALYSIS_RATE, line.startMs, line.endMs)

        const score = await scoreInWorker(ref, aligned.slice())

        const take = await saveTake({
          packId: data.pack.id,
          lineId: line.id,
          takeId: `t${Date.now().toString(36)}`,
          blob: result.blob,
          leadTrimMs: result.leadTrimMs,
          createdAt: Date.now(),
          score,
        })

        setTakes((prev) => {
          const next = new Map(prev)
          next.set(line.id, [...(prev.get(line.id) ?? []), take])
          return next
        })
        setActiveTakeIds((prev) => {
          const current = takes.get(line.id)?.find((t) => t.takeId === prev[line.id])
          // Yeni take daha iyiyse otomatik seç; değilse kullanıcının seçimini bozma
          return (current?.score?.total ?? -1) > score.total ? prev : { ...prev, [line.id]: take.takeId }
        })
      } catch (err) {
        console.error('Kayıt işlenemedi', err)
      } finally {
        setPhase('idle')
      }
    },
    [data, recorder, stopLoop, takes],
  )

  const record = useCallback(
    async (line: PackLine) => {
      const video = videoRef.current
      if (!video || !data) return
      if (phase !== 'idle') return

      await resumeAudio()
      if (!(await recorder.arm())) return

      setSelectedId(line.id)
      setPhase('leadin')
      setCueProgress(0)
      waveRef.current?.reset()
      setUserEnvelope(null)
      sessionRef.current = { line, marked: false, finishing: false, deadline: null, markTimer: null }

      // Geri sayımı video zamanından değil kendi saatimizden sürüyoruz.
      // Video'ya bağlıydı ve leadInMs 800 ms olduğu için sayaç doğrudan "1"de
      // başlıyordu; ayrıca klibin başındaki repliklerde geri sayıma yer kalmıyor.
      video.muted = false
      video.pause()
      video.currentTime = Math.max(0, (line.startMs - line.leadInMs) / 1000)

      for (let beat = BEATS; beat >= 1; beat--) {
        if (sessionRef.current?.line.id !== line.id) return // iptal edildi
        setCountdown(beat)
        await new Promise((r) => setTimeout(r, BEAT_MS))
      }
      if (sessionRef.current?.line.id !== line.id) return
      setCountdown(0)

      // Kaydı runway'de başlatıyoruz: MediaRecorder'ın ilk 100-200 ms'i
      // güvenilmez, repliğin başında kaybolmasındansa baştan kırpmak daha iyi.
      if (!(await recorder.start())) {
        setPhase('idle')
        sessionRef.current = null
        return
      }
      const playFrom = video.currentTime * 1000
      await video.play().catch(() => undefined)

      /**
       * Duvar saati yedeği. Durdurma koşulu yalnızca video zamanına bakarsa
       * mikrofon açık kalabiliyor: klibin son repliğinde video `currentTime`
       * süreye dayanıp donuyor, sekme arka plana alındığında da
       * requestAnimationFrame duruyor. İkisinde de kayıt kendiliğinden bitmiyordu.
       */
      const rate = video.playbackRate || 1
      const expectedMs = (line.endMs + TAIL_MS - playFrom) / rate
      const session = sessionRef.current

      /**
       * Repliğin başladığı anı işaretler: kaydın hizalaması buna dayanıyor.
       * İki kaynaktan da çağrılıyor ve tekrar çağrılmaya karşı korumalı.
       */
      const markNow = () => {
        const current = sessionRef.current
        if (!current || current.marked) return
        current.marked = true
        recorder.markLineStart()
        // Referans sesi mikrofona sızmasın diye replik boyunca susturuyoruz
        if (videoRef.current) videoRef.current.muted = true
        setPhase('recording')
      }

      if (session) {
        session.deadline = setTimeout(() => void finishRecording(line), Math.max(500, expectedMs + 1200))
        /*
         * İşaretlemeyi yalnızca rAF'a bırakmak yetmiyor: sekme arka plana
         * alındığında requestAnimationFrame duruyor, video oynamaya devam
         * ediyor ve replik hiç işaretlenmiyor — kayıt alınıyor ama hizalaması
         * kayboluyor, "erken/geç girdin" ölçümü çöpe gidiyor. Zamanlayıcı
         * garantiyi veriyor, rAF görünürken daha isabetli olanı yapıyor.
         */
        session.markTimer = setTimeout(markNow, Math.max(0, (line.startMs - playFrom) / rate))
      }

      const tick = () => {
        const current = sessionRef.current
        if (!current || !videoRef.current) return
        const t = videoRef.current.currentTime * 1000

        if (!current.marked && t >= current.line.startMs) markNow()

        if (current.marked) {
          const span = current.line.endMs - current.line.startMs
          const progress = Math.max(0, Math.min(1, (t - current.line.startMs) / span))
          setCueProgress(progress)
          // Canlı dalga formu: seviyeyi ref'ten okuyoruz, her karede render yok
          waveRef.current?.push(progress, recorder.levelRef.current)
        }

        // Video bittiyse zaman ilerlemeyeceği için eşik hiç yakalanmaz
        if (t >= current.line.endMs + TAIL_MS || videoRef.current.ended) {
          void finishRecording(current.line)
          return
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    },
    [data, phase, recorder, finishRecording],
  )

  const cancelRecording = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    void finishRecording(session.line)
  }, [finishRecording])

  /** Seçili repliğin referansını dinlet (kayıt yok). */
  const playReference = useCallback(
    async (line: PackLine) => {
      const video = videoRef.current
      if (!video || phase !== 'idle') return
      // Graf kurulduysa video sesi Web Audio'dan akıyor; context askıdaysa sessiz kalır
      await resumeAudio()
      video.muted = false
      video.volume = 1
      video.currentTime = line.startMs / 1000
      await video.play().catch(() => undefined)
      const stopAt = () => {
        if (!videoRef.current) return
        if (videoRef.current.currentTime * 1000 >= line.endMs) {
          videoRef.current.pause()
          return
        }
        rafRef.current = requestAnimationFrame(stopAt)
      }
      stopLoop()
      rafRef.current = requestAnimationFrame(stopAt)
    },
    [phase, stopLoop],
  )

  /** Kullanıcının take'ini tek başına dinlet. */
  const playTake = useCallback(async (take: StoredTake) => {
    await resumeAudio()
    const url = URL.createObjectURL(take.blob)
    const audio = new Audio(url)
    audio.onended = () => URL.revokeObjectURL(url)
    await audio.play().catch(() => URL.revokeObjectURL(url))
  }, [])

  /** Tüm sahneyi kayıtlarla birlikte önizle. */
  const previewAll = useCallback(async () => {
    const video = videoRef.current
    if (!video || !pack || phase !== 'idle') return
    await resumeAudio()
    setBusy(t('player.preparingPreview'))

    const scheduled: Array<{ line: PackLine; buffer: AudioBuffer; take: StoredTake }> = []
    for (const line of pack.lines) {
      const take = activeTakeFor(line.id)
      if (!take) continue
      try {
        scheduled.push({ line, take, buffer: await decodeAudio(await take.blob.arrayBuffer()) })
      } catch {
        /* bozuk take'i sessizce atla */
      }
    }
    setBusy(null)

    const ctx = audioContext()
    const graph = await ensureGraph()
    const playing = new Set<AudioBufferSourceNode>()
    const fired = new Set<string>()

    video.muted = false
    video.volume = 1
    video.currentTime = 0
    await video.play().catch(() => undefined)

    const tick = () => {
      if (!videoRef.current || videoRef.current.paused) {
        playing.forEach((s) => s.stop())
        playing.clear()
        if (graph) {
          graph.main.gain.value = 1
          graph.side.gain.value = 0
        }
        return
      }
      const t = videoRef.current.currentTime * 1000
      // Replik aralığında orijinal sese seçilen moda göre müdahale et
      const inLine = pack.lines.some((l) => t >= l.startMs && t <= l.endMs && activeTakeFor(l.id))
      if (graph) {
        if (!inLine) {
          graph.main.gain.value = 1
          graph.side.gain.value = 0
        } else if (originalMode === 'duck') {
          graph.main.gain.value = 0.12
          graph.side.gain.value = 0
        } else if (originalMode === 'removeVocals') {
          graph.main.gain.value = 0
          graph.side.gain.value = 1
        } else {
          graph.main.gain.value = 0
          graph.side.gain.value = 0
        }
      } else {
        videoRef.current.volume = inLine && originalMode !== 'duck' ? 0 : inLine ? 0.12 : 1
      }

      for (const item of scheduled) {
        const startAt = item.line.startMs - item.take.leadTrimMs
        if (!fired.has(item.line.id) && t >= startAt && t < startAt + 250) {
          fired.add(item.line.id)
          const src = ctx.createBufferSource()
          src.buffer = item.buffer
          src.connect(ctx.destination)
          src.onended = () => playing.delete(src)
          src.start()
          playing.add(src)
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    stopLoop()
    rafRef.current = requestAnimationFrame(tick)
  }, [pack, phase, activeTakeFor, stopLoop, ensureGraph, originalMode])

  const removeTake = useCallback(async (take: StoredTake) => {
    await deleteTake(take.key)
    setTakes((prev) => {
      const next = new Map(prev)
      next.set(take.lineId, (prev.get(take.lineId) ?? []).filter((t) => t.key !== take.key))
      return next
    })
  }, [])

  /**
   * Seçili take'in zarfını çıkarır.
   * Kayıt biter bitmez take listeye düştüğü için bu efekt kendiliğinden
   * tetikleniyor; ayrıca eski bir take'e geçildiğinde de doğru zarf geliyor.
   */
  useEffect(() => {
    if (!selected || phase !== 'idle') return
    const take = activeTakeFor(selected.id)
    if (!take) {
      setUserEnvelope(null)
      return
    }
    let alive = true
    ;(async () => {
      try {
        const buffer = await decodeAudio(await take.blob.arrayBuffer())
        const pcm = resampleLinear(buffer.getChannelData(0), buffer.sampleRate, ANALYSIS_RATE)
        // Kayıt replikten leadTrimMs önce başlıyor; aynı hizadan çizmek için kırp
        const trim = Math.round((take.leadTrimMs / 1000) * ANALYSIS_RATE)
        if (alive) setUserEnvelope(envelopeColumns(pcm.subarray(Math.min(trim, pcm.length))))
      } catch {
        if (alive) setUserEnvelope(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [selected, phase, activeTakeFor])

  // Klavye: boşluk kaydeder, Escape durdurur, ok tuşları replik gezer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (e.code === 'Space' && selected) {
        e.preventDefault()
        if (phase === 'idle') void record(selected)
        else if (phase !== 'processing') cancelRecording()
      } else if (e.key === 'Escape' && phase !== 'idle') {
        e.preventDefault()
        cancelRecording()
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && phase === 'idle' && selected) {
        e.preventDefault()
        const i = lines.findIndex((l) => l.id === selected.id)
        const next = lines[i + (e.key === 'ArrowDown' ? 1 : -1)]
        if (next) setSelectedId(next.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, phase, record, cancelRecording, lines])

  useEffect(
    () => () => {
      stopLoop()
      // Sayfadan ayrılırken bekleyen zaman aşımı tetiklenmesin
      if (sessionRef.current?.deadline) clearTimeout(sessionRef.current.deadline)
      if (sessionRef.current?.markTimer) clearTimeout(sessionRef.current.markTimer)
      sessionRef.current = null
    },
    [stopLoop],
  )

  if (error) {
    return (
      <div className="notice notice-bad">
        {error} <a href="#/">{t('player.back')}</a>
      </div>
    )
  }
  if (!pack || !data) {
    return (
      <div className="row">
        <span className="spinner" aria-hidden="true" />
        <span className="muted">{t('player.loadingPack')}</span>
      </div>
    )
  }

  const selectedTakes = selected ? takes.get(selected.id) ?? [] : []
  const activeTake = selected ? activeTakeFor(selected.id) : null
  const recordedCount = pack.lines.filter((l) => activeTakeFor(l.id)).length
  const character = selected ? pack.characters.find((c) => c.id === selected.characterId) : undefined

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <a className="btn btn-ghost btn-sm" href="#/">
          {t('player.back')}
        </a>
        <h1 style={{ fontSize: 20 }}>{pack.title}</h1>
        <span className="badge">
          {t('player.lineProgress', { done: recordedCount, total: pack.lines.length })}
        </span>
        <button
          className="btn btn-ghost btn-sm"
          style={{ marginLeft: 'auto' }}
          onClick={() => onNavigate({ name: 'studio', packId, local, project })}
        >
          {t('player.editLines')}
        </button>
      </div>

      <div className="studio-layout">
        <div>
          <div className="stage">
            <video ref={videoRef} src={data.videoUrl} playsInline preload="auto" />

            {phase === 'recording' && <div className="rec-dot">{t('player.recording')}</div>}
            {phase === 'leadin' && countdown > 0 && (
              // key: her vuruşta yeniden monte olsun ki animasyon tekrar oynasın
              <div className="countdown" key={countdown}>
                {countdown}
              </div>
            )}

            <div className="stage-overlay">
              {selected && (
                <div className="cue">
                  <span className="cue-speaker" style={{ color: character?.color }}>
                    {character?.name ?? t('player.character')}
                  </span>
                  {selected.text || <span className="faint">{t('player.noText')}</span>}
                  {phase === 'recording' && (
                    <div className="cue-progress">
                      <span style={{ transform: `scaleX(${cueProgress})` }} />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {selected && data && (
            <LineWaveform
              ref={waveRef}
              refPcm={data.refPcm}
              sampleRate={ANALYSIS_RATE}
              line={selected}
              userEnvelope={userEnvelope}
              recording={phase === 'recording'}
            />
          )}

          <div className="transport">
            {phase === 'idle' ? (
              <button className="btn btn-primary" onClick={() => selected && record(selected)} disabled={!selected}>
                {t('player.record')}
              </button>
            ) : phase === 'processing' ? (
              <button className="btn" disabled>
                <span className="spinner" aria-hidden="true" /> {t('player.scoring')}
              </button>
            ) : (
              <button className="btn" onClick={cancelRecording}>
                {t('player.stop')}
              </button>
            )}

            <button
              className="btn"
              onClick={() => selected && playReference(selected)}
              disabled={!selected || phase !== 'idle'}
            >
              {t('player.playReference')}
            </button>
            <button className="btn" onClick={previewAll} disabled={phase !== 'idle' || recordedCount === 0}>
              {t('player.previewScene')}
            </button>

            <div className="level-meter" title={t('player.micLevel')}>
              {/* Gradyan ebeveynde; bu perde sağdan ölçeklenerek dolmayan kısmı örtüyor */}
              <span style={{ transform: `scaleX(${1 - recorder.level})` }} />
            </div>
          </div>

          {recorder.error && (
            <div className="notice notice-bad" style={{ marginTop: 12 }}>
              {t(recorder.error)}
            </div>
          )}
          {busy && <div className="notice" style={{ marginTop: 12 }}>{busy}</div>}

          {activeTake?.score && <ScoreCard score={activeTake.score} />}

          {selectedTakes.length > 0 && (
            <div className="card" style={{ marginTop: 12, padding: '4px 16px 12px' }}>
              <div className="faint" style={{ fontSize: 12, padding: '10px 0 2px' }}>
                {t('player.takesTitle')}
              </div>
              {selectedTakes.map((take, i) => (
                <div className="take-row" key={take.key}>
                  <input
                    type="radio"
                    name="active-take"
                    checked={activeTake?.key === take.key}
                    onChange={() => setActiveTakeIds((p) => ({ ...p, [take.lineId]: take.takeId }))}
                    aria-label={t('player.useTake', { n: i + 1 })}
                  />
                  <span>{t('player.takeN', { n: i + 1 })}</span>
                  {take.score && (
                    <span className={`score-pill ${scoreClass(take.score.total)}`}>{take.score.total}</span>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => playTake(take)}>
                    {t('player.listen')}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => removeTake(take)}
                  >
                    {t('player.delete')}
                  </button>
                </div>
              ))}
            </div>
          )}

          <ExportPanel
            pack={pack}
            data={data}
            activeTakeFor={activeTakeFor}
            originalMode={originalMode}
            onOriginalModeChange={setOriginalMode}
          />
        </div>

        <div className="card script">
          <div className="script-head">
            <strong>{t('player.script')}</strong>
            <span className="faint" style={{ fontSize: 12, marginLeft: 'auto' }}>
              {t('player.spaceHint')}
            </span>
          </div>
          <div className="script-list" role="listbox" aria-label={t('studio.lines')}>
            {pack.lines.map((line, i) => {
              const take = activeTakeFor(line.id)
              const char = pack.characters.find((c) => c.id === line.characterId)
              return (
                <button
                  key={line.id}
                  className="line-row"
                  role="option"
                  aria-selected={selected?.id === line.id}
                  onClick={() => phase === 'idle' && setSelectedId(line.id)}
                >
                  <span className="line-swatch" style={{ background: char?.color ?? 'var(--line-strong)' }} />
                  <span className="line-text">
                    <strong>{line.text || t('player.lineN', { n: i + 1 })}</strong>
                    <span className="time mono">
                      {formatMs(line.startMs)} · {((line.endMs - line.startMs) / 1000).toFixed(1)}s
                    </span>
                  </span>
                  {take?.score ? (
                    <span className={`score-pill ${scoreClass(take.score.total)}`}>{take.score.total}</span>
                  ) : (
                    <span className="score-pill" style={{ background: 'var(--bg-sunken)', color: 'var(--text-faint)' }}>
                      –
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </>
  )
}
