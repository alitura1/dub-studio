/**
 * Transkripsiyon sonucunu paket repliklerine uygular.
 *
 * Kritik gözlem: Whisper'ın zaman damgaları konuşma sınırı değil, sesi baştan
 * sona kaplayan bitişik aralıklar. 14 saniyelik demo klipte ilk parça
 * "0.00 - 5.44" diyor, oysa konuşma 1.00'da başlayıp 4.35'te bitiyor. Bunları
 * doğrudan replik sınırı yapmak her repliğin başına saniyelerce sessizlik
 * ekliyor; kayıt da skorlama da bozuluyor.
 *
 * Bu yüzden sınırları her zaman enerji tabanlı `segmentLines` veriyor,
 * Whisper yalnızca metni sağlıyor. İkisi örtüşmeye göre eşleştiriliyor.
 */

import type { PackCharacter, PackLine } from '../../lib/pack.ts'
import { segmentLines } from '../../lib/audio/segment.ts'
import { ANALYSIS_RATE } from '../../lib/audio/resample.ts'
import { overlapMs, type TranscriptSegment } from './whisper.ts'

/** Bir aralığa en çok örtüşen transkript parçasının metnini bulur. */
function bestText(
  range: { startMs: number; endMs: number },
  segments: TranscriptSegment[],
  minRatio = 0.2,
): string {
  let best: TranscriptSegment | null = null
  let bestOverlap = 0
  for (const seg of segments) {
    const o = overlapMs(range, seg)
    if (o > bestOverlap) {
      bestOverlap = o
      best = seg
    }
  }
  const minOverlap = (range.endMs - range.startMs) * minRatio
  return best && bestOverlap >= minOverlap ? best.text : ''
}

/** Mevcut satır sınırlarını koruyup metinleri en çok örtüşen parçadan alır. */
export function fillLineTexts(lines: PackLine[], segments: TranscriptSegment[]): PackLine[] {
  return lines.map((line) => {
    const text = bestText(line, segments)
    return text ? { ...line, text } : line
  })
}

/**
 * Replikleri sıfırdan kurar: sınırlar sesin enerjisinden, metinler Whisper'dan.
 * Karakterler sırayla dağıtılır — konuşma sırası genelde dönüşümlü.
 */
export function buildLinesFromTranscript(
  pcm: Float32Array,
  segments: TranscriptSegment[],
  characters: PackCharacter[],
  durationMs: number,
  sampleRate = ANALYSIS_RATE,
): PackLine[] {
  const ranges = segmentLines(pcm, { sampleRate })
  const source = ranges.length > 0 ? ranges : segments
  return source
    .map((range, i) => ({
      id: `l${i + 1}`,
      characterId: characters[i % Math.max(1, characters.length)]?.id ?? 'k1',
      startMs: Math.max(0, Math.round(range.startMs)),
      endMs: Math.min(durationMs, Math.round(range.endMs)),
      text: bestText(range, segments),
      leadInMs: 800,
    }))
    .filter((l) => l.endMs - l.startMs >= 150)
}
