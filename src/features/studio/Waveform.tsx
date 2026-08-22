import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { PackCharacter, PackLine } from '../../lib/pack.ts'

interface Props {
  pcm: Float32Array
  durationMs: number
  lines: PackLine[]
  characters: PackCharacter[]
  selectedId: string | null
  playheadMs: number
  onSelect: (lineId: string) => void
  onChange: (lineId: string, startMs: number, endMs: number) => void
  onSeek: (ms: number) => void
}

const HEIGHT = 150
const HANDLE_PX = 7

type Drag = { lineId: string; edge: 'start' | 'end' | 'move'; grabMs: number } | null

/**
 * Dalga formu + sürüklenebilir replik sınırları.
 *
 * Canvas kullanıyoruz: 26 saniyelik bir klip 1200 sütuna indirgeniyor ve
 * DOM'da binlerce çubuk oluşturmadan 60 fps'de yeniden çiziliyor.
 */
export function Waveform(props: Props) {
  const { pcm, durationMs, lines, characters, selectedId, playheadMs } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag>(null)

  /** Zarfı bir kez hesaplayıp önbelleğe alıyoruz; her karede yeniden taramak pahalı. */
  const peaks = useMemo(() => {
    const columns = 1200
    const out = new Float32Array(columns)
    const per = Math.max(1, Math.floor(pcm.length / columns))
    for (let c = 0; c < columns; c++) {
      let peak = 0
      const start = c * per
      for (let i = start; i < Math.min(pcm.length, start + per); i++) {
        const v = Math.abs(pcm[i])
        if (v > peak) peak = v
      }
      out[c] = peak
    }
    let max = 0
    for (const v of out) if (v > max) max = v
    if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max
    return out
  }, [pcm])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const width = wrap.clientWidth
    canvas.width = width * dpr
    canvas.height = HEIGHT * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, HEIGHT)

    const msToX = (ms: number) => (ms / durationMs) * width

    // Replik blokları
    for (const line of lines) {
      const char = characters.find((c) => c.id === line.characterId)
      const x1 = msToX(line.startMs)
      const x2 = msToX(line.endMs)
      ctx.fillStyle = (char?.color ?? '#e0573f') + (line.id === selectedId ? '38' : '1c')
      ctx.fillRect(x1, 0, Math.max(1, x2 - x1), HEIGHT)
      ctx.fillStyle = char?.color ?? '#e0573f'
      ctx.fillRect(x1 - 1, 0, 2, HEIGHT)
      ctx.fillRect(x2 - 1, 0, 2, HEIGHT)
    }

    // Dalga formu
    const mid = HEIGHT / 2
    ctx.fillStyle = '#8f8580'
    for (let x = 0; x < width; x++) {
      const peak = peaks[Math.floor((x / width) * peaks.length)] ?? 0
      const h = Math.max(1, peak * (HEIGHT * 0.44))
      ctx.fillRect(x, mid - h, 1, h * 2)
    }

    // Oynatma imleci
    const px = msToX(playheadMs)
    ctx.fillStyle = '#f2ece8'
    ctx.fillRect(px, 0, 1.5, HEIGHT)
  }, [peaks, lines, characters, selectedId, playheadMs, durationMs])

  useEffect(() => {
    draw()
    const observer = new ResizeObserver(draw)
    if (wrapRef.current) observer.observe(wrapRef.current)
    return () => observer.disconnect()
  }, [draw])

  const eventMs = useCallback(
    (clientX: number): number => {
      const rect = wrapRef.current?.getBoundingClientRect()
      if (!rect) return 0
      return Math.max(0, Math.min(durationMs, ((clientX - rect.left) / rect.width) * durationMs))
    },
    [durationMs],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const ms = eventMs(e.clientX)
      const rect = wrapRef.current?.getBoundingClientRect()
      if (!rect) return
      const msPerPx = durationMs / rect.width
      const grab = HANDLE_PX * msPerPx

      for (const line of lines) {
        if (Math.abs(ms - line.startMs) <= grab) {
          dragRef.current = { lineId: line.id, edge: 'start', grabMs: ms }
          props.onSelect(line.id)
          e.currentTarget.setPointerCapture(e.pointerId)
          return
        }
        if (Math.abs(ms - line.endMs) <= grab) {
          dragRef.current = { lineId: line.id, edge: 'end', grabMs: ms }
          props.onSelect(line.id)
          e.currentTarget.setPointerCapture(e.pointerId)
          return
        }
      }
      const inside = lines.find((l) => ms >= l.startMs && ms <= l.endMs)
      if (inside) {
        dragRef.current = { lineId: inside.id, edge: 'move', grabMs: ms }
        props.onSelect(inside.id)
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
      props.onSeek(ms)
    },
    [eventMs, lines, durationMs, props],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const line = lines.find((l) => l.id === drag.lineId)
      if (!line) return
      const ms = eventMs(e.clientX)

      if (drag.edge === 'start') {
        props.onChange(line.id, Math.min(ms, line.endMs - 120), line.endMs)
      } else if (drag.edge === 'end') {
        props.onChange(line.id, line.startMs, Math.max(ms, line.startMs + 120))
      } else {
        const delta = ms - drag.grabMs
        const span = line.endMs - line.startMs
        const start = Math.max(0, Math.min(durationMs - span, line.startMs + delta))
        drag.grabMs = ms
        props.onChange(line.id, start, start + span)
      }
    },
    [eventMs, lines, durationMs, props],
  )

  const endDrag = useCallback(() => {
    dragRef.current = null
  }, [])

  return (
    <div
      className="wave-wrap"
      ref={wrapRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <canvas ref={canvasRef} style={{ height: HEIGHT }} />
    </div>
  )
}
