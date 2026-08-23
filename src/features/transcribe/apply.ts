/**
 * Transkripsiyon sonucunu paket repliklerine uygular.
 *
 * İki ayrı sorun çözülüyor:
 *
 * 1. **Sınırlar.** Whisper'ın zaman damgaları konuşma sınırı değil, sesi baştan
 *    sona kaplayan bitişik aralıklar. 14 saniyelik demo klipte ilk parça
 *    "0.00 - 5.44" diyor, oysa konuşma 1.00'da başlayıp 4.35'te bitiyor.
 *    Bu yüzden sınırlar her zaman enerji tabanlı `segmentLines`'tan geliyor.
 *
 * 2. **Metnin nereye yazılacağı.** Her repliğe "en çok örtüşen parça"yı
 *    vermek, uzun bir parça birkaç repliği birden kapsadığında aynı metni
 *    hepsine yazıyordu. Artık dağıtım kelime düzeyinde: her kelime kendi zaman
 *    damgasına göre *tek bir* repliğe düşüyor, dolayısıyla tekrar üretmek
 *    yapısal olarak mümkün değil.
 */

import type { PackCharacter, PackLine } from '../../lib/pack.ts'
import { segmentLines } from '../../lib/audio/segment.ts'
import { ANALYSIS_RATE } from '../../lib/audio/resample.ts'
import { overlapMs, type TranscriptResult, type TranscriptWord } from './whisper.ts'

interface Range {
  startMs: number
  endMs: number
}

/** Kelimeleri birleştirirken noktalamadan önceki boşluğu temizler. */
function joinWords(words: TranscriptWord[]): string {
  return words
    .map((w) => w.text)
    .join(' ')
    .replace(/\s+([,.!?;:…])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Her kelimeyi tam olarak bir repliğe dağıtır.
 *
 * Ölçüt kelimenin orta noktası: replik sınırları enerjiden geldiği için
 * kenarlarda birkaç on ms kayma normal, ama orta nokta neredeyse her zaman
 * doğru repliğin içinde kalıyor. Hiçbir repliğe düşmeyen kelimeler (replikler
 * arası sessizlikte kalanlar) `tolerance` kadar yakındaki repliğe iliştiriliyor,
 * daha uzaktakiler atılıyor — replikte olmayan bir söz metne girmesin.
 */
function distributeWords(lines: Range[], words: TranscriptWord[], tolerance = 400): string[] {
  const buckets: TranscriptWord[][] = lines.map(() => [])

  for (const word of words) {
    const mid = (word.startMs + word.endMs) / 2
    let index = lines.findIndex((l) => mid >= l.startMs && mid <= l.endMs)

    if (index < 0) {
      // Sınırların hemen dışında kalanlar için en yakın repliği ara
      let bestDistance = Infinity
      lines.forEach((l, i) => {
        const distance = mid < l.startMs ? l.startMs - mid : mid > l.endMs ? mid - l.endMs : 0
        if (distance < bestDistance) {
          bestDistance = distance
          index = i
        }
      })
      if (bestDistance > tolerance) continue
    }
    if (index >= 0) buckets[index].push(word)
  }

  return buckets.map(joinWords)
}

/**
 * Kelime damgası yoksa parçaları repliklere birebir dağıtır.
 *
 * Örtüşmesi en yüksek çiftten başlayarak eşleştiriyoruz ve kullanılan parçayı
 * bir daha vermiyoruz: aynı metnin birden çok repliğe yazılmasının önüne
 * geçen kısım bu.
 */
function distributeSegments(lines: Range[], segments: Range[], texts: string[]): string[] {
  const pairs: Array<{ line: number; seg: number; overlap: number }> = []
  lines.forEach((line, li) => {
    segments.forEach((seg, si) => {
      const o = overlapMs(line, seg)
      if (o > 0) pairs.push({ line: li, seg: si, overlap: o })
    })
  })
  pairs.sort((a, b) => b.overlap - a.overlap)

  const out = lines.map(() => '')
  const usedLine = new Set<number>()
  const usedSeg = new Set<number>()
  for (const p of pairs) {
    if (usedLine.has(p.line) || usedSeg.has(p.seg)) continue
    usedLine.add(p.line)
    usedSeg.add(p.seg)
    out[p.line] = texts[p.seg]
  }
  return out
}

function textsFor(lines: Range[], result: TranscriptResult): string[] {
  if (result.words.length > 0) return distributeWords(lines, result.words)
  return distributeSegments(
    lines,
    result.segments,
    result.segments.map((s) => s.text),
  )
}

/** Mevcut satır sınırlarını koruyup metinleri dağıtır. */
export function fillLineTexts(lines: PackLine[], result: TranscriptResult): PackLine[] {
  const texts = textsFor(lines, result)
  return lines.map((line, i) => (texts[i] ? { ...line, text: texts[i] } : line))
}

/**
 * Replikleri sıfırdan kurar: sınırlar sesin enerjisinden, metinler transkriptten.
 * Karakterler sırayla dağıtılır — konuşma sırası genelde dönüşümlü.
 */
export function buildLinesFromTranscript(
  pcm: Float32Array,
  result: TranscriptResult,
  characters: PackCharacter[],
  durationMs: number,
  sampleRate = ANALYSIS_RATE,
): PackLine[] {
  const ranges: Range[] = segmentLines(pcm, { sampleRate })
  const source = ranges.length > 0 ? ranges : result.segments
  const texts = textsFor(source, result)

  return source
    .map((range, i) => ({
      id: `l${i + 1}`,
      characterId: characters[i % Math.max(1, characters.length)]?.id ?? 'k1',
      startMs: Math.max(0, Math.round(range.startMs)),
      endMs: Math.min(durationMs, Math.round(range.endMs)),
      text: texts[i] ?? '',
      leadInMs: 800,
    }))
    .filter((l) => l.endMs - l.startMs >= 150)
}
