/**
 * IndexedDB kalıcılığı.
 *
 * Take'ler ve yüklenen projeler burada duruyor: sayfa yenilendiğinde
 * kullanıcının 10 dakikalık emeği kaybolmasın. Sunucu yok — her şey cihazda.
 */

import type { Pack } from './pack.ts'
import type { ScoreBreakdown } from '../features/scoring/score.ts'

const DB_NAME = 'choicer-voicer'
const DB_VERSION = 1
const TAKES = 'takes'
const PROJECTS = 'projects'

export interface StoredTake {
  key: string
  packId: string
  lineId: string
  takeId: string
  blob: Blob
  /**
   * Kaydın başı ile repliğin başı arasındaki fark.
   * Kayıt geri sayım sırasında başlıyor; hem skorlarken hem mikslerken bu
   * kadar kaydırmazsak kullanıcının sesi replikten önce duyulur.
   */
  leadTrimMs: number
  createdAt: number
  score: ScoreBreakdown | null
}

export interface StoredProject {
  id: string
  pack: Pack
  video: Blob
  updatedAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(TAKES)) {
        const store = db.createObjectStore(TAKES, { keyPath: 'key' })
        store.createIndex('packLine', ['packId', 'lineId'])
        store.createIndex('pack', 'packId')
      }
      if (!db.objectStoreNames.contains(PROJECTS)) {
        db.createObjectStore(PROJECTS, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode)
        const req = fn(transaction.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export const takeKey = (packId: string, lineId: string, takeId: string) => `${packId}|${lineId}|${takeId}`

export async function saveTake(take: Omit<StoredTake, 'key'>): Promise<StoredTake> {
  const full: StoredTake = { ...take, key: takeKey(take.packId, take.lineId, take.takeId) }
  await tx(TAKES, 'readwrite', (s) => s.put(full))
  return full
}

export async function deleteTake(key: string): Promise<void> {
  await tx(TAKES, 'readwrite', (s) => s.delete(key))
}

/** Bir paketin tüm take'lerini satır kimliğine göre gruplayarak döner. */
export async function loadTakes(packId: string): Promise<Map<string, StoredTake[]>> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const grouped = new Map<string, StoredTake[]>()
    const req = db.transaction(TAKES, 'readonly').objectStore(TAKES).index('pack').openCursor(IDBKeyRange.only(packId))
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) {
        for (const list of grouped.values()) list.sort((a, b) => a.createdAt - b.createdAt)
        resolve(grouped)
        return
      }
      const take = cursor.value as StoredTake
      const list = grouped.get(take.lineId)
      if (list) list.push(take)
      else grouped.set(take.lineId, [take])
      cursor.continue()
    }
    req.onerror = () => reject(req.error)
  })
}

export async function clearPackTakes(packId: string): Promise<void> {
  const grouped = await loadTakes(packId)
  await Promise.all([...grouped.values()].flat().map((t) => deleteTake(t.key)))
}

export async function saveProject(project: StoredProject): Promise<void> {
  await tx(PROJECTS, 'readwrite', (s) => s.put(project))
}

export async function loadProject(id: string): Promise<StoredProject | undefined> {
  return tx<StoredProject | undefined>(PROJECTS, 'readonly', (s) => s.get(id))
}

export async function listProjects(): Promise<StoredProject[]> {
  const all = await tx<StoredProject[]>(PROJECTS, 'readonly', (s) => s.getAll())
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteProject(id: string): Promise<void> {
  await tx(PROJECTS, 'readwrite', (s) => s.delete(id))
  await clearPackTakes(id)
}
