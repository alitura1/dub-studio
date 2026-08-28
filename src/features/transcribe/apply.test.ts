import { describe, expect, it } from 'vitest'
import { fillLineTexts, linesFromWords } from './apply.ts'
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

describe('linesFromWords', () => {
  const chars = [
    { id: 'k1', name: 'A', color: '#f00' },
    { id: 'k2', name: 'B', color: '#00f' },
  ]

  it('cümle sonu noktalamasında böler ve karakterleri sırayla dağıtır', () => {
    const lines = linesFromWords(
      words([
        [1000, 1300, 'Merhaba'],
        [1300, 1700, 'dünya.'],
        [1900, 2200, 'Nasılsın?'],
      ]),
      chars,
      10000,
    )

    expect(lines).toHaveLength(2)
    expect(lines[0].text).toBe('Merhaba dünya.')
    expect(lines[0].characterId).toBe('k1')
    expect(lines[1].text).toBe('Nasılsın?')
    expect(lines[1].characterId).toBe('k2')
  })

  it('uzun sessizlikte böler', () => {
    const lines = linesFromWords(
      words([
        [1000, 1300, 'bir'],
        [1300, 1600, 'iki'],
        // 900 ms boşluk
        [2500, 2800, 'üç'],
      ]),
      chars,
      10000,
    )
    expect(lines.map((l) => l.text)).toEqual(['bir iki', 'üç'])
  })

  it('noktalamasız uzun repliği en geniş duraktan böler', () => {
    /*
     * Gerçek vaka: "Life is a precious gift to throw yours away and be a real
     * slap in the lord's face, don't you think?" tek parça 5.5 saniye geliyordu
     * ve tek nefeste seslendirilemiyordu.
     */
    const spec: Array<[number, number, string]> = []
    for (let i = 0; i < 12; i++) {
      const start = 1000 + i * 500
      // 6. kelimeden önce belirgin bir durak
      const shift = i >= 6 ? 700 : 0
      spec.push([start + shift, start + shift + 300, `k${i}`])
    }
    const lines = linesFromWords(words(spec), chars, 20000)

    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(l.endMs - l.startMs).toBeLessThan(4600)
  })

  it('sınırları kelime damgalarından alır, paylı', () => {
    const lines = linesFromWords(words([[2000, 2600, 'tek.']]), chars, 10000)
    expect(lines[0].startMs).toBe(1880)
    expect(lines[0].endMs).toBe(2720)
  })

  it('komşu replikler çakışmaz', () => {
    const lines = linesFromWords(
      words([
        [1000, 1400, 'bir.'],
        [1450, 1900, 'iki.'],
      ]),
      chars,
      10000,
    )
    expect(lines).toHaveLength(2)
    expect(lines[0].endMs).toBeLessThanOrEqual(lines[1].startMs)
  })
})
