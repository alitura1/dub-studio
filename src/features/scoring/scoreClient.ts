/** Skorlama Worker'ına promise tabanlı arayüz. */

import { ANALYSIS_RATE } from '../../lib/audio/resample.ts'
import type { ScoreBreakdown } from './score.ts'
import type { ScoreRequest, ScoreResponse } from './scoring.worker.ts'

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (r: ScoreBreakdown) => void; reject: (e: Error) => void }>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./scoring.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<ScoreResponse>) => {
    const entry = pending.get(event.data.id)
    if (!entry) return
    pending.delete(event.data.id)
    if (event.data.ok) entry.resolve(event.data.result)
    else entry.reject(new Error(event.data.error))
  }
  worker.onerror = (event) => {
    for (const entry of pending.values()) entry.reject(new Error(event.message || 'Skorlama başarısız'))
    pending.clear()
  }
  return worker
}

export function scoreInWorker(
  ref: Float32Array,
  user: Float32Array,
  sampleRate = ANALYSIS_RATE,
): Promise<ScoreBreakdown> {
  const id = nextId++
  // Kopya çıkarıyoruz: transfer edilen tampon çağıranın elinde boş kalır ve
  // aynı referans dilimini bir sonraki take için tekrar kullanamayız.
  const refCopy = ref.slice().buffer
  const userCopy = user.slice().buffer
  const request: ScoreRequest = { id, ref: refCopy, user: userCopy, sampleRate }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage(request, [refCopy, userCopy])
  })
}
