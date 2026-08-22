/**
 * Paket yükleme.
 *
 * İki kaynak var: public/packs (dağıtılan paketler) ve public/packs/yerel
 * (telifli meme klipleri — gitignore'lu, yalnızca geliştirme makinesinde).
 * Yerel indeks yoksa sessizce atlanıyor, böylece aynı kod deploy'da da çalışıyor.
 */

import { parsePack, type Pack, type PackIndexEntry } from './pack.ts'
import { listProjects } from './store.ts'

export interface PackSource {
  entry: PackIndexEntry
  /** Hazır paketlerde klasör URL'si, yüklenen projelerde null. */
  baseUrl: string | null
}

const PUBLIC_INDEX = `${import.meta.env.BASE_URL}packs/index.json`
const LOCAL_INDEX = `${import.meta.env.BASE_URL}packs/yerel/index.json`

async function fetchIndex(url: string): Promise<PackIndexEntry[]> {
  try {
    const res = await fetch(url)
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

export async function loadPackIndex(): Promise<PackSource[]> {
  const [pub, local] = await Promise.all([fetchIndex(PUBLIC_INDEX), fetchIndex(LOCAL_INDEX)])
  const base = import.meta.env.BASE_URL
  return [...pub, ...local].map((entry) => ({
    entry,
    baseUrl: `${base}packs/${entry.dir}/`,
  }))
}

/** Kullanıcının kendi yüklediği projeleri de aynı listede gösteriyoruz. */
export async function loadProjectIndex(): Promise<PackSource[]> {
  const projects = await listProjects()
  return projects.map((p) => ({
    entry: {
      id: p.id,
      title: p.pack.title,
      dir: p.id,
      durationMs: p.pack.durationMs,
      lineCount: p.pack.lines.length,
    },
    baseUrl: null,
  }))
}

export async function fetchPack(baseUrl: string): Promise<Pack> {
  const res = await fetch(`${baseUrl}pack.json`)
  if (!res.ok) throw new Error(`pack.json yüklenemedi (${res.status})`)
  return parsePack(await res.json())
}
