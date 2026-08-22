/// <reference lib="webworker" />
/**
 * Skorlamayı ana iş parçacığından uzak tutar.
 *
 * YIN + DTW bir replik için ~50-150 ms sürüyor; UI iş parçacığında yapınca
 * skor kartı belirirken video oynatımı takılıyordu.
 */

import { scoreTake, type ScoreBreakdown } from './score.ts'

export interface ScoreRequest {
  id: number
  ref: ArrayBuffer
  user: ArrayBuffer
  sampleRate: number
}

export type ScoreResponse =
  | { id: number; ok: true; result: ScoreBreakdown }
  | { id: number; ok: false; error: string }

self.onmessage = (event: MessageEvent<ScoreRequest>) => {
  const { id, ref, user, sampleRate } = event.data
  try {
    const result = scoreTake({
      ref: new Float32Array(ref),
      user: new Float32Array(user),
      sampleRate,
    })
    const response: ScoreResponse = { id, ok: true, result }
    self.postMessage(response)
  } catch (err) {
    const response: ScoreResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
    self.postMessage(response)
  }
}
