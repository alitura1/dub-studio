/**
 * Dublaj paketi veri modeli.
 *
 * Tek doğruluk kaynağı: CLI bunu yazar, uygulama bunu okur. Doğrulama
 * fonksiyonu ikisinde de çalışır, böylece elle düzenlenmiş bir pack.json
 * uygulamayı sessizce bozmak yerine anlaşılır bir hata veriyor.
 */

export const PACK_SCHEMA_VERSION = 1

export interface PackCharacter {
  id: string
  name: string
  color: string
}

export interface PackLine {
  id: string
  characterId: string
  startMs: number
  endMs: number
  /** Replik metni. CLI boş bırakır, Studio'da doldurulur. */
  text: string
  /** Kayıttan önceki geri sayım süresi. */
  leadInMs: number
}

export interface PackSource {
  kind: 'url' | 'file'
  ref?: string
  startMs?: number
  durationMs?: number
}

export interface Pack {
  schemaVersion: number
  id: string
  title: string
  /** Paket klasörüne göreli video dosyası. */
  video: string
  /** Paket klasörüne göreli 16 kHz mono referans WAV. */
  reference: string
  durationMs: number
  characters: PackCharacter[]
  lines: PackLine[]
  source?: PackSource
  /** Telifli içerik: yalnızca yerel klasörde tutulur, deploy edilmez. */
  local?: boolean
}

export interface PackIndexEntry {
  id: string
  title: string
  dir: string
  durationMs: number
  lineCount: number
  local?: boolean
}

export const DEFAULT_CHARACTER: PackCharacter = {
  id: 'ana',
  name: 'Karakter 1',
  color: '#e0573f',
}

export const CHARACTER_COLORS = [
  '#e0573f',
  '#3f8ee0',
  '#43b581',
  '#c678dd',
  '#e0b83f',
]

export class PackError extends Error {}

function req<T>(value: T | undefined | null, field: string): T {
  if (value === undefined || value === null) throw new PackError(`pack.json: "${field}" alanı eksik`)
  return value
}

/** Bilinmeyen bir nesneyi Pack'e doğrular. Hatalı alanlarda PackError atar. */
export function parsePack(raw: unknown): Pack {
  if (typeof raw !== 'object' || raw === null) throw new PackError('pack.json bir nesne değil')
  const o = raw as Record<string, unknown>

  const id = req(o.id as string, 'id')
  const durationMs = Number(req(o.durationMs as number, 'durationMs'))
  if (!isFinite(durationMs) || durationMs <= 0) throw new PackError('pack.json: durationMs pozitif olmalı')

  const characters = Array.isArray(o.characters) && o.characters.length > 0
    ? (o.characters as PackCharacter[])
    : [DEFAULT_CHARACTER]

  const rawLines = Array.isArray(o.lines) ? o.lines : []
  const lines: PackLine[] = rawLines.map((l, i) => {
    const line = l as Record<string, unknown>
    const startMs = Number(line.startMs)
    const endMs = Number(line.endMs)
    if (!isFinite(startMs) || !isFinite(endMs) || endMs <= startMs) {
      throw new PackError(`pack.json: ${i + 1}. satırın zaman aralığı geçersiz`)
    }
    const characterId = typeof line.characterId === 'string' ? line.characterId : characters[0].id
    if (!characters.some((c) => c.id === characterId)) {
      throw new PackError(`pack.json: ${i + 1}. satır tanımsız karakter "${characterId}" kullanıyor`)
    }
    return {
      id: typeof line.id === 'string' ? line.id : `l${i + 1}`,
      characterId,
      startMs,
      endMs,
      text: typeof line.text === 'string' ? line.text : '',
      leadInMs: isFinite(Number(line.leadInMs)) ? Number(line.leadInMs) : 800,
    }
  })

  lines.sort((a, b) => a.startMs - b.startMs)

  return {
    schemaVersion: Number(o.schemaVersion) || PACK_SCHEMA_VERSION,
    id,
    title: typeof o.title === 'string' ? o.title : id,
    video: typeof o.video === 'string' ? o.video : 'clip.mp4',
    reference: typeof o.reference === 'string' ? o.reference : 'ref.wav',
    durationMs,
    characters,
    lines,
    source: o.source as PackSource | undefined,
    local: Boolean(o.local),
  }
}

/** Kimliği dosya/URL adından türetir. */
export function slugify(input: string): string {
  const map: Record<string, string> = {
    ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i',
    ö: 'o', Ö: 'o', ş: 's', Ş: 's', ü: 'u', Ü: 'u',
  }
  return input
    .split('')
    .map((c) => map[c] ?? c)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'paket'
}

export function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 100) / 10)
  const m = Math.floor(total / 60)
  const s = total - m * 60
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)}s`
}
