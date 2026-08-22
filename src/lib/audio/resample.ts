/**
 * Kanal indirgeme ve örnekleme hızı dönüşümü.
 * Skorlama zinciri her şeyi 16 kHz mono'ya indirger: perde takibi için
 * fazlası gereksiz, DTW maliyetini de dörtte bire düşürüyor.
 */

/** Çok kanallı sesi tek kanala indirger (basit ortalama). */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  const len = channels[0].length
  const out = new Float32Array(len)
  for (const ch of channels) {
    const n = Math.min(len, ch.length)
    for (let i = 0; i < n; i++) out[i] += ch[i]
  }
  const inv = 1 / channels.length
  for (let i = 0; i < len; i++) out[i] *= inv
  return out
}

/**
 * Aşağı örneklemeden önce kutu (box) filtresi uygular.
 * Filtresiz doğrusal interpolasyon, 16 kHz'e inerken 8 kHz üstünü katlayıp
 * YIN'in periyot tahminini bozuyor — bu ucuz alçak geçiren onu engelliyor.
 */
function boxFilter(x: Float32Array, width: number): Float32Array {
  if (width <= 1) return x
  const out = new Float32Array(x.length)
  const half = width >> 1
  let acc = 0
  for (let i = 0; i < Math.min(width, x.length); i++) acc += x[i]
  for (let i = 0; i < x.length; i++) {
    const add = i + half
    const drop = i - half - 1
    if (i > 0) {
      if (add < x.length) acc += x[add]
      if (drop >= 0) acc -= x[drop]
    }
    const lo = Math.max(0, i - half)
    const hi = Math.min(x.length - 1, i + half)
    out[i] = acc / (hi - lo + 1)
  }
  return out
}

/** Doğrusal interpolasyonla yeniden örnekler; gerekiyorsa önce anti-alias uygular. */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input
  const ratio = fromRate / toRate
  const src = ratio > 1.05 ? boxFilter(input, Math.max(2, Math.round(ratio))) : input
  const outLen = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(src.length - 1, i0 + 1)
    const frac = pos - i0
    out[i] = src[i0] * (1 - frac) + src[i1] * frac
  }
  return out
}

/** Skorlama zincirinin standart giriş formatı. */
export const ANALYSIS_RATE = 16000

export function toAnalysisPcm(channels: Float32Array[], sampleRate: number): Float32Array {
  return resampleLinear(toMono(channels), sampleRate, ANALYSIS_RATE)
}

/** Bir PCM diliminden [startMs, endMs) aralığını kopyalar. */
export function slicePcm(pcm: Float32Array, sampleRate: number, startMs: number, endMs: number): Float32Array {
  const a = Math.max(0, Math.floor((startMs / 1000) * sampleRate))
  const b = Math.min(pcm.length, Math.ceil((endMs / 1000) * sampleRate))
  return b > a ? pcm.slice(a, b) : new Float32Array(0)
}
