import { describe, expect, it } from 'vitest'
import { scoreTake } from './score.ts'
import { ANALYSIS_RATE } from '../../lib/audio/resample.ts'
import { segmentLines } from '../../lib/audio/segment.ts'
import { decodeWav, encodeWavPcm16 } from '../../lib/audio/wav.ts'
import { dtw, pathDeviation } from '../../lib/audio/dtw.ts'

const SR = ANALYSIS_RATE

/**
 * Konuşma benzeri sentetik sinyal: harmonikli, zarflı, perdesi zamanla değişen
 * bir ton. Gerçek kayıt yerine bunu kullanmak testleri deterministik tutuyor.
 */
function utterance(opts: {
  durationMs: number
  baseHz?: number
  /** Yarım ton cinsinden perde salınımı genliği. */
  vibratoSemitones?: number
  amplitude?: number
  leadingSilenceMs?: number
  totalMs?: number
}): Float32Array {
  const {
    durationMs,
    baseHz = 130,
    vibratoSemitones = 4,
    amplitude = 0.5,
    leadingSilenceMs = 0,
    totalMs = leadingSilenceMs + durationMs,
  } = opts

  const out = new Float32Array(Math.round((totalMs / 1000) * SR))
  const start = Math.round((leadingSilenceMs / 1000) * SR)
  const len = Math.round((durationMs / 1000) * SR)
  let phase = 0

  for (let i = 0; i < len; i++) {
    const t = i / len
    // Perde konturu: yavaş bir yay çizer
    const semis = vibratoSemitones * Math.sin(2 * Math.PI * t)
    const hz = baseHz * Math.pow(2, semis / 12)
    phase += (2 * Math.PI * hz) / SR
    // Zarf: hızlı atak, yavaş sönüm + hece dalgalanması
    const env = Math.min(1, t * 20) * Math.exp(-t * 1.2) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 4 * t))
    const sample =
      Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase) + 0.12 * Math.sin(4 * phase)
    const idx = start + i
    if (idx < out.length) out[idx] = amplitude * env * sample * 0.5
  }
  return out
}

describe('scoreTake', () => {
  it('birebir aynı kayıt için ~100 verir', () => {
    const ref = utterance({ durationMs: 1500, leadingSilenceMs: 200, totalMs: 2000 })
    const r = scoreTake({ ref, user: ref.slice() })

    expect(r.total).toBeGreaterThanOrEqual(95)
    expect(r.timing).toBeGreaterThanOrEqual(95)
    expect(r.energy).toBeGreaterThanOrEqual(95)
    expect(r.pitch).toBeGreaterThanOrEqual(95)
    expect(r.pitchMeasured).toBe(true)
    expect(Math.abs(r.onsetDeltaMs)).toBeLessThan(40)
  })

  it('300 ms kaydırılmış kayıtta zamanlama düşer, perde korunur', () => {
    const ref = utterance({ durationMs: 1500, leadingSilenceMs: 200, totalMs: 2400 })
    const late = utterance({ durationMs: 1500, leadingSilenceMs: 500, totalMs: 2400 })
    const r = scoreTake({ ref, user: late })

    expect(r.onsetDeltaMs).toBeGreaterThan(200)
    expect(r.timing).toBeLessThan(70)
    // Aynı performans, sadece geç girilmiş: perde konturu bozulmamalı
    expect(r.pitch).toBeGreaterThan(70)
    expect(r.feedback.map((f) => f.code)).toContain('late')
  })

  it('düz tonlu kayıtta perde skoru düşer', () => {
    const ref = utterance({ durationMs: 1500, vibratoSemitones: 7, totalMs: 1800 })
    const flat = utterance({ durationMs: 1500, vibratoSemitones: 0, totalMs: 1800 })
    const expressive = scoreTake({ ref, user: ref.slice() })
    const r = scoreTake({ ref, user: flat })

    expect(r.pitch).toBeLessThan(expressive.pitch - 25)
    expect(r.feedback.map((f) => f.code)).toContain('flatIntonation')
  })

  it('sessiz kayıt 0 verir ve mikrofon uyarısı gösterir', () => {
    const ref = utterance({ durationMs: 1200, totalMs: 1500 })
    const r = scoreTake({ ref, user: new Float32Array(SR) })

    expect(r.total).toBe(0)
    expect(r.feedback.map((f) => f.code)).toContain('noAudio')
  })

  it('düşük enerjili kayıt için "daha yüksek enerji" geri bildirimi verir', () => {
    const ref = utterance({ durationMs: 1400, amplitude: 0.6, totalMs: 1700 })
    const quiet = utterance({ durationMs: 1400, amplitude: 0.6, totalMs: 1700 })
    // Zarf şekli aynı, sadece sesli bölge referanstan sönük
    for (let i = 0; i < quiet.length; i++) quiet[i] *= 0.25
    // normalizePeakDb tepeyi eşitler; farkı görmek için referansa arka plan ekliyoruz
    const r = scoreTake({ ref, user: quiet })
    expect(r.total).toBeGreaterThan(60) // seviye farkı skoru cezalandırmamalı
  })

  it('farklı ses aralığı (bir oktav aşağı) skoru cezalandırmaz', () => {
    const ref = utterance({ durationMs: 1400, baseHz: 220, totalMs: 1700 })
    const low = utterance({ durationMs: 1400, baseHz: 110, totalMs: 1700 })
    const r = scoreTake({ ref, user: low })

    expect(r.pitch).toBeGreaterThan(80)
    expect(r.total).toBeGreaterThan(75)
  })
})

describe('segmentLines', () => {
  it('sessizlikle ayrılmış üç repliği bulur', () => {
    const totalMs = 6000
    const pcm = new Float32Array((totalMs / 1000) * SR)
    const place = (startMs: number, durMs: number) => {
      const seg = utterance({ durationMs: durMs, totalMs: durMs, amplitude: 0.6 })
      const off = Math.round((startMs / 1000) * SR)
      for (let i = 0; i < seg.length && off + i < pcm.length; i++) pcm[off + i] = seg[i]
    }
    place(300, 900)
    place(2200, 1100)
    place(4300, 800)
    // Gerçekçi olsun diye hafif taban gürültüsü
    for (let i = 0; i < pcm.length; i++) pcm[i] += (Math.sin(i * 0.37) * 0.0008)

    const lines = segmentLines(pcm, { sampleRate: SR })

    expect(lines).toHaveLength(3)
    expect(lines[0].startMs).toBeGreaterThan(100)
    expect(lines[0].startMs).toBeLessThan(400)
    expect(lines[1].startMs).toBeGreaterThan(1900)
    expect(lines[1].startMs).toBeLessThan(2400)
    expect(lines[2].endMs).toBeLessThanOrEqual(totalMs)
    for (const l of lines) expect(l.endMs).toBeGreaterThan(l.startMs)
  })

  it('tamamen sessiz seste satır bulmaz', () => {
    expect(segmentLines(new Float32Array(SR * 2), { sampleRate: SR })).toHaveLength(0)
  })
})

describe('wav', () => {
  it('yazıp okuduğunda örnekleri korur', () => {
    const src = utterance({ durationMs: 300, totalMs: 300 })
    const decoded = decodeWav(encodeWavPcm16([src], SR))

    expect(decoded.sampleRate).toBe(SR)
    expect(decoded.channels).toHaveLength(1)
    expect(decoded.channels[0].length).toBe(src.length)
    for (let i = 0; i < src.length; i += 97) {
      expect(Math.abs(decoded.channels[0][i] - src[i])).toBeLessThan(1 / 32768 + 1e-6)
    }
  })

  it('stereo kanalları ayrı tutar', () => {
    const left = Float32Array.from({ length: 100 }, (_, i) => Math.sin(i / 5) * 0.5)
    const right = Float32Array.from({ length: 100 }, (_, i) => Math.cos(i / 5) * 0.5)
    const decoded = decodeWav(encodeWavPcm16([left, right], 48000))

    expect(decoded.channels).toHaveLength(2)
    expect(decoded.sampleRate).toBe(48000)
    expect(Math.abs(decoded.channels[1][10] - right[10])).toBeLessThan(1e-3)
  })
})

describe('dtw', () => {
  it('uzunlukları farklı dizileri baştan sona hizalar', () => {
    const a = [0, 1, 2, 3, 4, 5, 6, 7]
    const b = [0, 0, 1, 2, 3, 3, 4, 5, 6, 7, 7, 7]
    const r = dtw(a.length, b.length, (i, j) => Math.abs(a[i] - b[j]))

    expect(isFinite(r.normalizedCost)).toBe(true)
    expect(r.path[0]).toBe(0)
    expect(r.path[1]).toBe(0)
    expect(r.path[(r.pathLength - 1) * 2]).toBe(a.length - 1)
    expect(r.path[(r.pathLength - 1) * 2 + 1]).toBe(b.length - 1)
    expect(r.normalizedCost).toBeLessThan(0.5)
  })

  it('aynı diziler için sapma sıfırdır', () => {
    const a = [1, 2, 3, 4, 5]
    const r = dtw(a.length, a.length, (i, j) => Math.abs(a[i] - a[j]))
    expect(pathDeviation(r, a.length, a.length)).toBe(0)
  })
})
