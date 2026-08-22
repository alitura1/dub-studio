/** Çerçeveleme ve enerji zarfı — hem satır bölme hem skorlama bunun üstünde çalışır. */

export interface FrameConfig {
  frameSize: number
  hopSize: number
}

export const DEFAULT_FRAMES: FrameConfig = { frameSize: 1024, hopSize: 512 }

export function frameCount(length: number, cfg: FrameConfig): number {
  if (length < cfg.frameSize) return length > 0 ? 1 : 0
  return 1 + Math.floor((length - cfg.frameSize) / cfg.hopSize)
}

/** Çerçeve başına doğrusal RMS. */
export function rmsEnvelope(x: Float32Array, cfg: FrameConfig = DEFAULT_FRAMES): Float32Array {
  const n = frameCount(x.length, cfg)
  const out = new Float32Array(n)
  for (let f = 0; f < n; f++) {
    const start = f * cfg.hopSize
    const end = Math.min(x.length, start + cfg.frameSize)
    let sum = 0
    for (let i = start; i < end; i++) sum += x[i] * x[i]
    const count = end - start
    out[f] = count > 0 ? Math.sqrt(sum / count) : 0
  }
  return out
}

export function toDb(rms: Float32Array, floorDb = -70): Float32Array {
  const out = new Float32Array(rms.length)
  for (let i = 0; i < rms.length; i++) {
    out[i] = rms[i] > 0 ? Math.max(floorDb, 20 * Math.log10(rms[i])) : floorDb
  }
  return out
}

/** Tepe değeri 0 dB'e taşır — kayıt seviyesi farkları skoru etkilemesin diye. */
export function normalizePeakDb(db: Float32Array, floorDb = -70): Float32Array {
  if (db.length === 0) return db
  let peak = -Infinity
  for (const v of db) if (v > peak) peak = v
  if (!isFinite(peak)) return db
  const out = new Float32Array(db.length)
  for (let i = 0; i < db.length; i++) out[i] = Math.max(floorDb, db[i] - peak)
  return out
}

/** Sıralı olmayan diziden yüzdelik değer (kopya üzerinde sıralar). */
export function percentile(values: ArrayLike<number>, p: number): number {
  if (values.length === 0) return 0
  const sorted = Array.from(values).sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[idx]
}

export function mean(values: ArrayLike<number>): number {
  if (values.length === 0) return 0
  let s = 0
  for (let i = 0; i < values.length; i++) s += values[i]
  return s / values.length
}

/** İki eşit uzunluktaki dizinin Pearson korelasyonu; sabit dizide 0 döner. */
export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  if (n < 2) return 0
  const ma = mean(Array.prototype.slice.call(a, 0, n))
  const mb = mean(Array.prototype.slice.call(b, 0, n))
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma
    const y = b[i] - mb
    num += x * y
    da += x * x
    db += y * y
  }
  if (da === 0 || db === 0) return 0
  return num / Math.sqrt(da * db)
}

/**
 * Ağırlıklı Pearson korelasyonu.
 *
 * Perde konturunda her çerçevenin güvenilirliği farklı: müzik altındaki
 * konuşmada bazı çerçeveler net, bazıları tahmin. Hepsini eşit saymak yerine
 * güvene göre ağırlıklandırmak, gerçek kliplerde tonlama puanını belirgin
 * biçimde daha kararlı yapıyor.
 */
export function weightedPearson(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  w: ArrayLike<number>,
): number {
  const n = Math.min(a.length, b.length, w.length)
  if (n < 2) return 0
  let sw = 0
  for (let i = 0; i < n; i++) sw += w[i]
  if (sw <= 0) return 0

  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += w[i] * a[i]
    mb += w[i] * b[i]
  }
  ma /= sw
  mb /= sw

  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma
    const y = b[i] - mb
    num += w[i] * x * y
    da += w[i] * x * x
    db += w[i] * y * y
  }
  if (da === 0 || db === 0) return 0
  return num / Math.sqrt(da * db)
}
