/**
 * YIN temel frekans takibi (de Cheveigné & Kawahara, 2002).
 *
 * Perde skorunu bu besliyor. Tek kritik nokta: güven (confidence) değeri
 * eşiğin altındaki çerçeveler NaN döner — sessiz ve gürültülü çerçevelerin
 * kontur karşılaştırmasına sızmasını istemiyoruz.
 */

import { bandpass } from './filter.ts'

export interface PitchOptions {
  sampleRate: number
  fmin?: number
  fmax?: number
  /** d'(tau) için mutlak eşik; küçük değer = daha seçici. */
  threshold?: number
  frameSize?: number
  hopSize?: number
  /** Bant geçiren ön filtre (arka plan müziği olan kliplerde şart). */
  prefilter?: boolean
  /**
   * Bir çerçevenin "sesli" sayılması için gereken en düşük güven.
   * YIN arama eşiğinden ayrı tutuyoruz: arama gevşek olabilir, ama konturu
   * neyin besleyeceğine burada karar veriyoruz.
   */
  voicedThreshold?: number
}

export interface PitchResult {
  /** Çerçeve başına Hz; sesli olmayan çerçevelerde NaN. */
  freq: Float32Array
  /** Çerçeve başına 0..1 güven (1 - d'(tauBest)). */
  confidence: Float32Array
}

const DEFAULTS = {
  fmin: 60,
  fmax: 500,
  threshold: 0.2,
  frameSize: 1024,
  hopSize: 512,
  prefilter: true,
  voicedThreshold: 0.55,
}

/** Tek bir çerçevede temel frekansı bulur. */
function yinFrame(
  buf: Float32Array,
  offset: number,
  windowSize: number,
  tauMin: number,
  tauMax: number,
  sampleRate: number,
  threshold: number,
): { freq: number; confidence: number } {
  const diff = new Float64Array(tauMax + 1)

  // 1) Fark fonksiyonu
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0
    for (let j = 0; j < windowSize; j++) {
      const a = buf[offset + j]
      const b = buf[offset + j + tau]
      const d = a - b
      sum += d * d
    }
    diff[tau] = sum
  }

  // 2) Kümülatif ortalamayla normalize edilmiş fark
  const cmnd = new Float64Array(tauMax + 1)
  cmnd[0] = 1
  let running = 0
  for (let tau = 1; tau <= tauMax; tau++) {
    running += diff[tau]
    cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1
  }

  // 3) Mutlak eşiğin altındaki ilk yerel minimum
  let bestTau = -1
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++
      bestTau = tau
      break
    }
  }
  // Eşiği geçen yoksa global minimumu al, güven düşük kalsın
  if (bestTau < 0) {
    let min = Infinity
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < min) {
        min = cmnd[tau]
        bestTau = tau
      }
    }
    if (bestTau < 0) return { freq: NaN, confidence: 0 }
  }

  // 4) Parabolik interpolasyon — çeyrek yarım tonluk kuantizasyon hatasını siler
  let tauEst = bestTau
  if (bestTau > tauMin && bestTau < tauMax) {
    const s0 = cmnd[bestTau - 1]
    const s1 = cmnd[bestTau]
    const s2 = cmnd[bestTau + 1]
    const denom = 2 * (2 * s1 - s2 - s0)
    if (denom !== 0) tauEst = bestTau + (s2 - s0) / denom
  }

  const confidence = Math.max(0, Math.min(1, 1 - cmnd[bestTau]))
  return { freq: tauEst > 0 ? sampleRate / tauEst : NaN, confidence }
}

export function detectPitch(input: Float32Array, options: PitchOptions): PitchResult {
  const o = { ...DEFAULTS, ...options }
  // Bandı daraltmak, müzik altındaki konuşmada sesli çerçeve oranını
  // birkaç yüzdeden yarıdan fazlaya çıkarıyor.
  const x = o.prefilter ? bandpass(input, o.sampleRate, o.fmin, 1100) : input
  const windowSize = o.frameSize >> 1
  const tauMax = Math.min(windowSize, Math.ceil(o.sampleRate / o.fmin))
  const tauMin = Math.max(2, Math.floor(o.sampleRate / o.fmax))

  const nFrames = x.length < o.frameSize ? (x.length > 0 ? 1 : 0) : 1 + Math.floor((x.length - o.frameSize) / o.hopSize)
  const freq = new Float32Array(nFrames)
  const confidence = new Float32Array(nFrames)

  // YIN, çerçeve başına windowSize + tauMax örnek okur; sonu sıfırla dolduruyoruz
  const padded = new Float32Array(x.length + o.frameSize + tauMax)
  padded.set(x)

  for (let f = 0; f < nFrames; f++) {
    const offset = f * o.hopSize
    if (tauMin >= tauMax) {
      freq[f] = NaN
      confidence[f] = 0
      continue
    }
    const r = yinFrame(padded, offset, windowSize, tauMin, tauMax, o.sampleRate, o.threshold)
    confidence[f] = r.confidence
    freq[f] = r.confidence >= o.voicedThreshold ? r.freq : NaN
  }
  return { freq, confidence }
}

/** Hz -> yarım ton (referans 55 Hz / A1). NaN korunur. */
export function hzToSemitones(freq: Float32Array): Float32Array {
  const out = new Float32Array(freq.length)
  for (let i = 0; i < freq.length; i++) {
    const f = freq[i]
    out[i] = f > 0 && isFinite(f) ? 12 * Math.log2(f / 55) : NaN
  }
  return out
}

/**
 * Konturu kendi medyanına göre ortalar.
 * Kullanıcının ses aralığı referanstan bir oktav uzakta olabilir; skorlanan şey
 * mutlak perde değil, tonlamanın *şekli*.
 */
export function centerContour(semitones: Float32Array): Float32Array {
  const valid: number[] = []
  for (const v of semitones) if (isFinite(v)) valid.push(v)
  if (valid.length === 0) return semitones
  valid.sort((a, b) => a - b)
  const median = valid[Math.floor(valid.length / 2)]
  const out = new Float32Array(semitones.length)
  for (let i = 0; i < semitones.length; i++) out[i] = semitones[i] - median
  return out
}

/**
 * Kontur üzerinde NaN'ları atlayan medyan filtre.
 *
 * YIN'in klasik hatası oktav atlaması: tek bir çerçevede 95 Hz yerine 190 Hz
 * okur. Bu sıçramalar korelasyonu, gerçek tonlama farkından daha çok bozuyordu.
 */
export function medianFilterContour(contour: Float32Array, window = 5): Float32Array {
  const out = new Float32Array(contour.length)
  const half = window >> 1
  const buf: number[] = []
  for (let i = 0; i < contour.length; i++) {
    if (!isFinite(contour[i])) {
      out[i] = NaN
      continue
    }
    buf.length = 0
    for (let j = Math.max(0, i - half); j <= Math.min(contour.length - 1, i + half); j++) {
      if (isFinite(contour[j])) buf.push(contour[j])
    }
    buf.sort((a, b) => a - b)
    out[i] = buf[buf.length >> 1]
  }
  return out
}
