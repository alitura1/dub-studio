import { describe, expect, it } from 'vitest'
import { fillLineTexts } from './apply.ts'
import type { TranscriptResult } from './whisper.ts'
import type { PackLine } from '../../lib/pack.ts'

const line = (id: string, startMs: number, endMs: number): PackLine => ({
  id,
  characterId: 'k1',
  startMs,
  endMs,
  text: '',
  leadInMs: 800,
})

/** Demo klipteki gerçek sınırlar: enerji tabanlı bölmeden geliyorlar. */
const LINES = [
  line('l1', 900, 4380),
  line('l2', 5160, 6870),
  line('l3', 7590, 10260),
  line('l4', 11020, 12060),
  line('l5', 12620, 13560),
]

/**
 * Whisper'ın gerçekten döndürdüğü parçalar: bitişik ve sesi baştan sona
 * kaplıyorlar, konuşma sınırlarıyla örtüşmüyorlar.
 */
const SEGMENTS: TranscriptResult['segments'] = [
  { startMs: 0, endMs: 5440, text: 'Where were you last night?' },
  { startMs: 5440, endMs: 7820, text: 'That is none of your business.' },
  { startMs: 7820, endMs: 11200, text: 'It became my business the moment you lied to me.' },
  { startMs: 11200, endMs: 12880, text: 'Then arrest me.' },
  { startMs: 12880, endMs: 13440, text: 'Or get out.' },
]

function words(spec: Array<[number, number, string]>): TranscriptResult['words'] {
  return spec.map(([startMs, endMs, text]) => ({ startMs, endMs, text }))
}

describe('fillLineTexts', () => {
  it('parça bazlı eşleştirmede aynı metni birden çok repliğe yazmaz', () => {
    // Tek bir uzun parça üç repliği birden kapsıyor — eski kod üçüne de
    // aynı metni yazıyordu.
    const result: TranscriptResult = {
      segments: [{ startMs: 0, endMs: 14000, text: 'Tek uzun parça' }],
      words: [],
    }
    const filled = fillLineTexts(LINES, result)
    const dolu = filled.filter((l) => l.text !== '')

    expect(dolu).toHaveLength(1)
    expect(dolu[0].text).toBe('Tek uzun parça')
  })

  it('parçaları repliklere birebir dağıtır', () => {
    const filled = fillLineTexts(LINES, { segments: SEGMENTS, words: [] })
    const texts = filled.map((l) => l.text)

    expect(texts).toEqual(SEGMENTS.map((s) => s.text))
    expect(new Set(texts).size).toBe(texts.length) // tekrar yok
  })

  it('kelime damgası varsa metni kelime kelime doğru repliğe koyar', () => {
    const result: TranscriptResult = {
      segments: SEGMENTS,
      words: words([
        [1000, 1300, 'Where'],
        [1300, 1600, 'were'],
        [1600, 1900, 'you'],
        [1900, 2400, 'last'],
        [2400, 3000, 'night?'],
        [5300, 5600, 'That'],
        [5600, 5800, 'is'],
        [5800, 6100, 'none'],
        [6100, 6800, 'of your business.'],
        [11100, 11500, 'Then'],
        [11500, 12000, 'arrest me.'],
      ]),
    }
    const filled = fillLineTexts(LINES, result)

    expect(filled[0].text).toBe('Where were you last night?')
    expect(filled[1].text).toBe('That is none of your business.')
    expect(filled[2].text).toBe('') // bu aralıkta kelime yok
    expect(filled[3].text).toBe('Then arrest me.')
  })

  it('replikler arası sessizliğe düşen kelimeyi en yakın repliğe iliştirir', () => {
    const result: TranscriptResult = {
      segments: [],
      // 4500 ms l1 (900-4380) ile l2 (5160-6870) arasında, l1'e 120 ms uzakta
      words: words([[4450, 4550, 'sonra']]),
    }
    const filled = fillLineTexts(LINES, result)
    expect(filled[0].text).toBe('sonra')
    expect(filled[1].text).toBe('')
  })

  it('hiçbir repliğe yakın olmayan kelimeyi atar', () => {
    const result: TranscriptResult = {
      segments: [],
      // Klibin başında, ilk replikten 900 ms'den uzakta
      words: words([[0, 100, 'gürültü']]),
    }
    expect(fillLineTexts(LINES, result).every((l) => l.text === '')).toBe(true)
  })

  it('noktalamadan önceki boşluğu temizler', () => {
    const result: TranscriptResult = {
      segments: [],
      words: words([
        [1000, 1400, 'Merhaba'],
        [1400, 1800, ','],
        [1800, 2200, 'dünya'],
        [2200, 2400, '!'],
      ]),
    }
    expect(fillLineTexts(LINES, result)[0].text).toBe('Merhaba, dünya!')
  })
})
