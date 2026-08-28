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
 * Kelime damgalarından doğrudan replik kurar.
 *
 * Ölçüm bunu gerektirdi: müziği baskın bir klipte enerji tabanlı bölme
 * 4-6 saniyelik bloklar üretiyordu (eşik gürültü tabanına göre hesaplandığı
 * için müzik onu yukarı çekiyor), oysa aynı yerde Whisper'ın kelime damgaları
 * gerçek replikleri veriyordu: "Don't come any closer." 2.14-2.90.
 *
 * Kelimeler `gapMs`'ten uzun sessizliklerde bölünüyor; cümle sonu noktalaması
 * da bölme sebebi, böylece iki cümle tek repliğe sıkışmıyor.
 */
export function linesFromWords(
  words: TranscriptWord[],
  characters: PackCharacter[],
  durationMs: number,
  gapMs = 450,
  padMs = 120,
  maxLineMs = 4000,
): PackLine[] {
  const groups: TranscriptWord[][] = []
  let current: TranscriptWord[] = []
  for (let i = 0; i < words.length; i++) {
    current.push(words[i])
    const next = words[i + 1]
    const endsSentence = /[.!?…]$/.test(words[i].text)
    const bigGap = next ? next.startMs - words[i].endMs > gapMs : true
    if (endsSentence || bigGap) {
      groups.push(current)
      current = []
    }
  }
  if (current.length > 0) groups.push(current)

  // Uzun cümleleri en geniş iç duraktan böl. Noktalama arasında nefes almadan
  // giden bir replik (ölçümde 5.5 sn'lik "Life is a precious gift…") tek
  // seferde seslendirilemiyor; kayıt penceresi de skor da anlamsızlaşıyor.
  const split = (group: TranscriptWord[]): TranscriptWord[][] => {
    const span = group[group.length - 1].endMs - group[0].startMs
    if (span <= maxLineMs || group.length < 4) return [group]
    let bestIndex = -1
    let bestGap = -1
    // Kenarlara çok yakın bölmek işe yaramaz; ortadaki yarıda arıyoruz
    for (let i = Math.max(1, Math.floor(group.length * 0.25)); i < Math.floor(group.length * 0.75); i++) {
      const gap = group[i].startMs - group[i - 1].endMs
      if (gap > bestGap) {
        bestGap = gap
        bestIndex = i
      }
    }
    if (bestIndex < 1) return [group]
    return [...split(group.slice(0, bestIndex)), ...split(group.slice(bestIndex))]
  }
  const parts = groups.flatMap(split)
  groups.length = 0
  groups.push(...parts)

  const lines = groups.map((group, i) => ({
    id: `l${i + 1}`,
    characterId: characters[i % Math.max(1, characters.length)]?.id ?? 'k1',
    startMs: Math.max(0, Math.round(group[0].startMs - padMs)),
    endMs: Math.min(durationMs, Math.round(group[group.length - 1].endMs + padMs)),
    text: joinWords(group),
    leadInMs: 800,
  }))

  // Pay eklemek komşuları çakıştırmış olabilir — ortada buluştur
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startMs < lines[i - 1].endMs) {
      const mid = Math.round((lines[i].startMs + lines[i - 1].endMs) / 2)
      lines[i - 1].endMs = mid
      lines[i].startMs = mid
    }
  }
  return lines.filter((l) => l.endMs - l.startMs >= 150)
}

/**
 * Replikleri sıfırdan kurar.
 *
 * Kelime damgası varsa sınırlar da metin de oradan geliyor (yukarıya bak).
 * Yoksa enerji tabanlı bölmeye düşülüyor — kelime damgası üretemeyen bir
 * modelde tek seçenek o.
 */
export function buildLinesFromTranscript(
  pcm: Float32Array,
  result: TranscriptResult,
  characters: PackCharacter[],
  durationMs: number,
  sampleRate = ANALYSIS_RATE,
): PackLine[] {
  if (result.words.length > 0) {
    return linesFromWords(result.words, characters, durationMs)
  }
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
