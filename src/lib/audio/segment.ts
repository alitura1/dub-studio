/**
 * Sesten replik satırlarını çıkarır.
 *
 * Hem CLI (paket üretirken) hem tarayıcı (kullanıcı video yüklediğinde)
 * bu fonksiyonu çağırır — ikisinin aynı sınırları bulması, Studio'da
 * gördüğün şeyin CLI'nin ürettiği şey olmasını garanti ediyor.
 */

import { DEFAULT_FRAMES, percentile, rmsEnvelope, toDb } from './rms.ts'

export interface SegmentOptions {
  sampleRate: number
  /** Bir satır sayılmak için gereken en kısa süre. */
  minLineMs?: number
  /** Bu süreden kısa sessizlikler satırı bölmez. */
  mergeGapMs?: number
  /** Bulunan sınırlara eklenen pay — kelime başları kesilmesin diye. */
  padMs?: number
  /** Gürültü tabanının kaç dB üstü konuşma sayılır. */
  thresholdOffsetDb?: number
  /** Bu süreyi aşan bloklar en derin sessizlikten bölünür. */
  maxLineMs?: number
}

export interface LineRange {
  startMs: number
  endMs: number
}

const DEFAULTS = {
  minLineMs: 200,
  mergeGapMs: 250,
  padMs: 120,
  thresholdOffsetDb: 12,
  maxLineMs: 9000,
}

export function segmentLines(pcm: Float32Array, options: SegmentOptions): LineRange[] {
  const o = { ...DEFAULTS, ...options }
  const cfg = DEFAULT_FRAMES
  const hopMs = (cfg.hopSize / o.sampleRate) * 1000
  const db = toDb(rmsEnvelope(pcm, cfg))
  if (db.length === 0) return []

  // Gürültü tabanı 20. yüzdelik: konuşma yoğun kliplerde medyandan çok daha
  // güvenilir, çünkü medyan konuşmanın kendi içine düşüyor.
  const noiseFloor = percentile(db, 20)
  const peak = percentile(db, 95)
  // İki adaydan yükseğini alıyoruz: sessiz kayıtta mutlak offset, gürültülü
  // kayıtta tepeye göreli eşik daha doğru sonuç veriyor.
  let enterDb = Math.max(noiseFloor + o.thresholdOffsetDb, peak - 25)
  if (enterDb >= peak) enterDb = (noiseFloor + peak) / 2
  const exitDb = enterDb - 4 // histerezis: sınırda titremeyi önler

  const spans: Array<[number, number]> = []
  let active = false
  let start = 0
  for (let i = 0; i < db.length; i++) {
    if (!active && db[i] > enterDb) {
      active = true
      start = i
    } else if (active && db[i] < exitDb) {
      active = false
      spans.push([start, i])
    }
  }
  if (active) spans.push([start, db.length])

  // Kısa boşlukları birleştir
  const merged: Array<[number, number]> = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && (span[0] - last[1]) * hopMs < o.mergeGapMs) last[1] = span[1]
    else merged.push([span[0], span[1]])
  }

  const totalMs = (pcm.length / o.sampleRate) * 1000
  const lines: LineRange[] = []
  for (const [a, b] of merged) {
    if ((b - a) * hopMs < o.minLineMs) continue
    for (const [sa, sb] of splitLong(db, a, b, hopMs, o.maxLineMs)) {
      lines.push({
        startMs: Math.max(0, sa * hopMs - o.padMs),
        endMs: Math.min(totalMs, sb * hopMs + o.padMs),
      })
    }
  }

  // Pay eklemek komşu satırları çakıştırmış olabilir — ortada buluştur
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startMs < lines[i - 1].endMs) {
      const mid = (lines[i].startMs + lines[i - 1].endMs) / 2
      lines[i - 1].endMs = mid
      lines[i].startMs = mid
    }
  }

  return lines.filter((l) => l.endMs - l.startMs >= o.minLineMs)
}

/** maxLineMs'i aşan blokları en sessiz çerçeveden ikiye ayırır (özyinelemeli). */
function splitLong(
  db: Float32Array,
  a: number,
  b: number,
  hopMs: number,
  maxLineMs: number,
): Array<[number, number]> {
  if ((b - a) * hopMs <= maxLineMs) return [[a, b]]
  const margin = Math.floor((b - a) * 0.25)
  let quietest = -1
  let quietestDb = Infinity
  for (let i = a + margin; i < b - margin; i++) {
    if (db[i] < quietestDb) {
      quietestDb = db[i]
      quietest = i
    }
  }
  if (quietest < 0) return [[a, b]]
  return [
    ...splitLong(db, a, quietest, hopMs, maxLineMs),
    ...splitLong(db, quietest, b, hopMs, maxLineMs),
  ]
}
