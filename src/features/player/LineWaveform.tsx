import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { DEFAULT_FRAMES, normalizePeakDb, rmsEnvelope, toDb } from '../../lib/audio/rms.ts'
import { slicePcm } from '../../lib/audio/resample.ts'
import type { PackLine } from '../../lib/pack.ts'
import { useT } from '../../i18n/index.tsx'

/**
 * Referans dalga formunun üzerine kullanıcının sesi.
 *
 * Skor kartı ne olduğunu kaydın *ardından* söylüyor; burada amaç konuşurken
 * hedefi görmek. Referans zarfı sabit bir şablon gibi arkada duruyor, kendi
 * sesin aynı eksende üstüne çiziliyor — nerede başlaman, nerede yükselip
 * alçalman gerektiği anlık olarak görünüyor.
 *
 * İki zarf da kendi tepesine göre normalize ediliyor: karşılaştırılan şey
 * ses yüksekliği değil, şekil. Mikrofonu kısık olan biri de aynı grafiği görüyor.
 */

const COLUMNS = 260
const HEIGHT = 84

export interface LineWaveformHandle {
  /** Yeni kayda başlarken canlı zarfı temizler. */
  reset(): void
  /** Kayıt sırasında her karede çağrılır. `progress` replik içinde 0..1. */
  push(progress: number, level: number): void
}

interface Props {
  /** Klibin tamamı, 16 kHz mono. */
  refPcm: Float32Array
  sampleRate: number
  line: PackLine
  /** Seçili take'in zarfı (0..1, COLUMNS uzunlukta) — yoksa yalnızca canlı çizim. */
  userEnvelope: Float32Array | null
  recording: boolean
}

/** PCM'i sabit sütun sayısına indirgenmiş, tepesi 1 olan bir zarfa çevirir. */
export function envelopeColumns(pcm: Float32Array, columns = COLUMNS): Float32Array {
  const out = new Float32Array(columns)
  if (pcm.length === 0) return out
  const db = normalizePeakDb(toDb(rmsEnvelope(pcm, DEFAULT_FRAMES)))
  if (db.length === 0) return out
  for (let c = 0; c < columns; c++) {
    const a = Math.floor((c / columns) * db.length)
    const b = Math.max(a + 1, Math.floor(((c + 1) / columns) * db.length))
    let peak = -Infinity
    for (let i = a; i < Math.min(db.length, b); i++) if (db[i] > peak) peak = db[i]
    // -50 dB..0 dB aralığını 0..1'e taşı
    out[c] = isFinite(peak) ? Math.max(0, Math.min(1, (peak + 50) / 50)) : 0
  }
  return out
}

export const LineWaveform = forwardRef<LineWaveformHandle, Props>(function LineWaveform(
  { refPcm, sampleRate, line, userEnvelope, recording },
  ref,
) {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef(new Float32Array(COLUMNS))
  const livePeakRef = useRef(0.02) // sıfıra bölmeyi önleyen taban
  const progressRef = useRef(-1)
  const rafRef = useRef<number | null>(null)

  const reference = useMemo(
    () => envelopeColumns(slicePcm(refPcm, sampleRate, line.startMs, line.endMs)),
    [refPcm, sampleRate, line.startMs, line.endMs],
  )

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const width = wrap.clientWidth
    if (canvas.width !== width * dpr || canvas.height !== HEIGHT * dpr) {
      canvas.width = width * dpr
      canvas.height = HEIGHT * dpr
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, HEIGHT)

    const mid = HEIGHT / 2
    const colWidth = width / COLUMNS

    const amp = HEIGHT / 2 - 3
    const at = (env: Float32Array, c: number, scale: number) =>
      Math.max(0.5, Math.min(1, env[c] * scale) * amp)

    /** Zarfı ortadan simetrik bir yol olarak kurar. */
    const path = (env: Float32Array, upTo: number, scale: number) => {
      ctx.beginPath()
      for (let c = 0; c < upTo; c++) ctx.lineTo(c * colWidth, mid - at(env, c, scale))
      for (let c = upTo - 1; c >= 0; c--) ctx.lineTo(c * colWidth, mid + at(env, c, scale))
      ctx.closePath()
    }

    // Referans: dolu ama sönük — üzerine oynanacak şablon
    path(reference, COLUMNS, 1)
    ctx.fillStyle = 'rgba(168, 158, 152, 0.38)'
    ctx.fill()

    /*
     * Kullanıcı katmanı dolgu değil kontur: opak dolgu referansı tamamen
     * örtüyordu ve karşılaştırma imkânsızlaşıyordu. İnce bir dolgu + net bir
     * çizgi ikisini aynı anda okunur tutuyor.
     */
    const drawUser = (env: Float32Array, upTo: number, scale: number) => {
      if (upTo <= 0) return
      path(env, upTo, scale)
      ctx.fillStyle = 'rgba(224, 87, 63, 0.22)'
      ctx.fill()
      ctx.strokeStyle = '#e0573f'
      ctx.lineWidth = 1.5
      ctx.lineJoin = 'round'
      ctx.stroke()
    }

    if (recording) {
      const upTo = progressRef.current < 0 ? 0 : Math.max(1, Math.round(progressRef.current * COLUMNS))
      drawUser(liveRef.current, upTo, 1 / livePeakRef.current)
    } else if (userEnvelope) {
      drawUser(userEnvelope, COLUMNS, 1)
    }

    // Orta çizgi ve oynatma imleci
    ctx.fillStyle = 'rgba(255,255,255,0.10)'
    ctx.fillRect(0, mid - 0.5, width, 1)
    if (recording && progressRef.current >= 0) {
      ctx.fillStyle = '#f2ece8'
      ctx.fillRect(progressRef.current * width, 0, 1.5, HEIGHT)
    }
  }, [reference, userEnvelope, recording])

  useImperativeHandle(
    ref,
    () => ({
      reset() {
        liveRef.current.fill(0)
        livePeakRef.current = 0.02
        progressRef.current = -1
      },
      push(progress, level) {
        progressRef.current = Math.max(0, Math.min(1, progress))
        const col = Math.min(COLUMNS - 1, Math.floor(progressRef.current * COLUMNS))
        // Sütuna düşen en yüksek değeri tut: kare hızı sütun sayısından bağımsız olsun
        if (level > liveRef.current[col]) liveRef.current[col] = level
        if (level > livePeakRef.current) livePeakRef.current = level
      },
    }),
    [],
  )

  // Kayıttayken kendi döngüsünde çiziyor; dışarıda React render'ı tetiklemiyor
  useEffect(() => {
    if (!recording) {
      draw()
      return
    }
    const tick = () => {
      draw()
      rafRef.current = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [recording, draw])

  useEffect(() => {
    const observer = new ResizeObserver(draw)
    if (wrapRef.current) observer.observe(wrapRef.current)
    return () => observer.disconnect()
  }, [draw])

  return (
    <div className="line-wave" ref={wrapRef}>
      <canvas ref={canvasRef} style={{ height: HEIGHT }} aria-hidden="true" />
      <div className="line-wave-legend">
        <span>
          <i className="swatch swatch-ref" /> {t('wave.reference')}
        </span>
        <span>
          <i className="swatch swatch-you" /> {t('wave.you')}
        </span>
      </div>
    </div>
  )
})
