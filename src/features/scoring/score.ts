/**
 * Benzerlik skoru: kullanıcının repliği referansa ne kadar yakın?
 *
 * Üç bağımsız eksen ölçülüyor:
 *   zamanlama — replik doğru anda mı başladı, tempo tuttu mu (DTW yolu)
 *   enerji     — vurgu ve şiddet profili benzer mi (hizalanmış RMS zarfı)
 *   perde      — tonlamanın *şekli* benzer mi (medyan ortalanmış YIN konturu)
 *
 * Mutlak perde bilerek yok sayılıyor: kalın sesli biri Homelander'ı taklit
 * ederken bir oktav aşağıda kalır, bu bir hata değil. Ölçtüğümüz şey kontur.
 *
 * Saf fonksiyon — Worker'dan da testten de aynı şekilde çağrılır.
 */

import { dtw, pathDeviation } from '../../lib/audio/dtw.ts'
import {
  DEFAULT_FRAMES,
  normalizePeakDb,
  pearson,
  rmsEnvelope,
  toDb,
  weightedPearson,
} from '../../lib/audio/rms.ts'
import { ANALYSIS_RATE } from '../../lib/audio/resample.ts'
import { centerContour, detectPitch, hzToSemitones, medianFilterContour } from '../../lib/audio/yin.ts'

export interface ScoreInput {
  /** 16 kHz mono referans dilimi. */
  ref: Float32Array
  /** 16 kHz mono kullanıcı kaydı, referansla aynı zaman sıfırından başlar. */
  user: Float32Array
  sampleRate?: number
}

/**
 * Geri bildirim, hazır metin yerine kod olarak dönüyor.
 *
 * Skor motoru bir Worker'da çalışıyor ve arayüzün hangi dilde olduğunu
 * bilmesi için bir sebep yok; çeviriyi gösteren taraf yapıyor. Kod + parametre
 * ayrımı olmadan iki dil desteklemek, dil bilgisini DSP katmanına sokmak
 * anlamına gelirdi.
 */
export type FeedbackCode =
  | 'noComparison'
  | 'noAudio'
  | 'refSilent'
  | 'lengthMismatch'
  | 'late'
  | 'early'
  | 'slower'
  | 'faster'
  | 'louder'
  | 'quieter'
  | 'refPitchUnmeasurable'
  | 'userPitchUnmeasurable'
  | 'flatIntonation'
  | 'wobblyIntonation'
  | 'intonationShapeOff'
  | 'veryClose'
  | 'improveTiming'
  | 'improveEnergy'
  | 'improvePitch'

export interface Feedback {
  code: FeedbackCode
  /** Metne gömülecek sayısal değerler (örn. kaç ms geç kalındığı). */
  ms?: number
}

export interface ScoreBreakdown {
  total: number
  timing: number
  energy: number
  pitch: number
  /** Pozitif = kullanıcı geç başladı. */
  onsetDeltaMs: number
  /** 1 = aynı tempo, >1 = kullanıcı daha yavaş. */
  tempoRatio: number
  /** Perde ölçülemediyse false — total buna göre yeniden ağırlıklandırılır. */
  pitchMeasured: boolean
  feedback: Feedback[]
}

const WEIGHTS = { timing: 0.35, energy: 0.3, pitch: 0.35 }
const SILENCE_RMS = 0.004 // ~-48 dBFS; altında "ses yok" sayıyoruz
const VOICED_REL_DB = -28 // tepe seviyeye göre konuşma sayılan eşik

const EMPTY: ScoreBreakdown = {
  total: 0,
  timing: 0,
  energy: 0,
  pitch: 0,
  onsetDeltaMs: 0,
  tempoRatio: 1,
  pitchMeasured: false,
  feedback: [],
}

function peakRms(x: Float32Array): number {
  let peak = 0
  for (const v of rmsEnvelope(x)) if (v > peak) peak = v
  return peak
}

/** Konuşmanın başladığı ilk çerçeve; hiç yoksa -1. */
function firstVoicedFrame(normDb: Float32Array): number {
  for (let i = 0; i < normDb.length; i++) if (normDb[i] > VOICED_REL_DB) return i
  return -1
}

/** Sondaki sessizliği kırpar — DTW'nin maliyetini boşluk domine etmesin. */
function trimTrailingSilence(x: Float32Array, sampleRate: number, keepMs = 200): Float32Array {
  const env = rmsEnvelope(x)
  const normDb = normalizePeakDb(toDb(env))
  let last = -1
  for (let i = normDb.length - 1; i >= 0; i--) {
    if (normDb[i] > VOICED_REL_DB) {
      last = i
      break
    }
  }
  if (last < 0) return x
  const keepSamples = Math.round((keepMs / 1000) * sampleRate)
  const end = Math.min(x.length, (last + 1) * DEFAULT_FRAMES.hopSize + keepSamples)
  return x.subarray(0, end)
}

/**
 * Korelasyonu 0-100'e taşır.
 * Ham r'yi doğrudan kullanmak gerçek performansları haksız yere eziyordu:
 * iyi bir taklit tipik olarak r≈0.7 veriyor, bu da 70 değil ~75 hak ediyor.
 */
function mapCorrelation(r: number): number {
  return Math.round(Math.max(0, Math.min(1, (r + 0.2) / 1.2)) * 100)
}

function decay(value: number, scale: number): number {
  return Math.exp(-Math.abs(value) / scale)
}

function countFinite(values: Float32Array): number {
  let n = 0
  for (const v of values) if (isFinite(v)) n++
  return n
}

export function scoreTake(input: ScoreInput): ScoreBreakdown {
  const sampleRate = input.sampleRate ?? ANALYSIS_RATE
  const hopMs = (DEFAULT_FRAMES.hopSize / sampleRate) * 1000

  if (input.ref.length === 0 || input.user.length === 0) {
    return { ...EMPTY, feedback: [{ code: 'noComparison' }] }
  }
  if (peakRms(input.user) < SILENCE_RMS) {
    return { ...EMPTY, feedback: [{ code: 'noAudio' }] }
  }
  if (peakRms(input.ref) < SILENCE_RMS) {
    return { ...EMPTY, feedback: [{ code: 'refSilent' }] }
  }

  const ref = trimTrailingSilence(input.ref, sampleRate)
  const user = trimTrailingSilence(input.user, sampleRate)

  const refDb = normalizePeakDb(toDb(rmsEnvelope(ref)))
  const userDb = normalizePeakDb(toDb(rmsEnvelope(user)))
  const n = refDb.length
  const m = userDb.length
  if (n === 0 || m === 0) return { ...EMPTY, feedback: [{ code: 'noComparison' }] }

  const refDetect = detectPitch(ref, { sampleRate })
  const userDetect = detectPitch(user, { sampleRate })
  const refPitch = medianFilterContour(centerContour(hzToSemitones(refDetect.freq)))
  const userPitch = medianFilterContour(centerContour(hzToSemitones(userDetect.freq)))

  // 0..1 ölçeğine indirilmiş enerji — DTW maliyetinde perdeyle kıyaslanabilir olsun
  const scale = (db: Float32Array) => {
    const out = new Float32Array(db.length)
    for (let i = 0; i < db.length; i++) out[i] = Math.max(0, Math.min(1, (db[i] + 60) / 60))
    return out
  }
  const refE = scale(refDb)
  const userE = scale(userDb)

  const cost = (i: number, j: number) => {
    const de = Math.abs(refE[i] - userE[j])
    const pr = refPitch[i]
    const pu = userPitch[j]
    // İkisinden biri sessizse sabit bir ceza: sesli/sessiz yapısı da bilgi taşıyor
    const dp = isFinite(pr) && isFinite(pu) ? Math.min(1, Math.abs(pr - pu) / 12) : 0.15
    return de + 0.6 * dp
  }

  const path = dtw(n, m, cost)
  if (!isFinite(path.normalizedCost)) {
    return { ...EMPTY, feedback: [{ code: 'lengthMismatch' }] }
  }

  // --- zamanlama ---
  const refOnset = firstVoicedFrame(refDb)
  const userOnset = firstVoicedFrame(userDb)
  const onsetDeltaMs = refOnset >= 0 && userOnset >= 0 ? (userOnset - refOnset) * hopMs : 0
  const devMs = pathDeviation(path, n, m) * hopMs
  const timing = Math.round(100 * (0.6 * decay(devMs, 200) + 0.4 * decay(onsetDeltaMs, 300)))

  // --- hizalanmış kontur karşılaştırmaları ---
  const alignedRefE: number[] = []
  const alignedUserE: number[] = []
  const alignedRefP: number[] = []
  const alignedUserP: number[] = []
  const pitchWeights: number[] = []
  for (let k = 0; k < path.pathLength; k++) {
    const i = path.path[k * 2]
    const j = path.path[k * 2 + 1]
    alignedRefE.push(refDb[i])
    alignedUserE.push(userDb[j])
    if (isFinite(refPitch[i]) && isFinite(userPitch[j])) {
      alignedRefP.push(refPitch[i])
      alignedUserP.push(userPitch[j])
      // İki taraftaki en zayıf güven belirleyici: emin olmadığımız bir
      // çerçeve, emin olduğumuz bir çerçeve kadar söz sahibi olmamalı.
      pitchWeights.push(Math.min(refDetect.confidence[i], userDetect.confidence[j]))
    }
  }

  const energy = mapCorrelation(pearson(alignedRefE, alignedUserE))
  const pitchMeasured = alignedRefP.length >= 5
  const pitch = pitchMeasured ? mapCorrelation(weightedPearson(alignedRefP, alignedUserP, pitchWeights)) : 0

  const refVoicedFrames = countFinite(refPitch)
  const userVoicedFrames = countFinite(userPitch)

  const totalWeight = pitchMeasured ? 1 : WEIGHTS.timing + WEIGHTS.energy
  const total = Math.round(
    (WEIGHTS.timing * timing + WEIGHTS.energy * energy + (pitchMeasured ? WEIGHTS.pitch * pitch : 0)) /
      totalWeight,
  )

  const tempoRatio = m / n

  return {
    total: Math.max(0, Math.min(100, total)),
    timing: Math.max(0, Math.min(100, timing)),
    energy,
    pitch,
    onsetDeltaMs: Math.round(onsetDeltaMs),
    tempoRatio,
    pitchMeasured,
    feedback: buildFeedback({
      onsetDeltaMs,
      tempoRatio,
      refDb,
      userDb,
      refPitch,
      userPitch,
      pitchMeasured,
      refVoicedFrames,
      userVoicedFrames,
      total,
      timing,
      pitch,
      energy,
    }),
  }
}

interface FeedbackContext {
  onsetDeltaMs: number
  tempoRatio: number
  refDb: Float32Array
  userDb: Float32Array
  refPitch: Float32Array
  userPitch: Float32Array
  pitchMeasured: boolean
  refVoicedFrames: number
  userVoicedFrames: number
  total: number
  timing: number
  pitch: number
  energy: number
}

/** Sesli çerçevelerin perde aralığı (5.-95. yüzdelik), yarım ton. */
function pitchSpread(contour: Float32Array): number {
  const valid = Array.from(contour).filter((v) => isFinite(v)).sort((a, b) => a - b)
  if (valid.length < 5) return 0
  const lo = valid[Math.floor(valid.length * 0.05)]
  const hi = valid[Math.floor(valid.length * 0.95)]
  return hi - lo
}

function buildFeedback(c: FeedbackContext): Feedback[] {
  const out: Feedback[] = []

  if (Math.abs(c.onsetDeltaMs) > 150) {
    out.push(
      c.onsetDeltaMs > 0
        ? { code: 'late', ms: Math.round(c.onsetDeltaMs) }
        : { code: 'early', ms: Math.round(-c.onsetDeltaMs) },
    )
  }

  if (c.tempoRatio > 1.25) out.push({ code: 'slower' })
  else if (c.tempoRatio < 0.8) out.push({ code: 'faster' })

  const voicedMean = (db: Float32Array) => {
    const vals = Array.from(db).filter((v) => v > VOICED_REL_DB)
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : -60
  }
  const energyDelta = voicedMean(c.userDb) - voicedMean(c.refDb)
  if (energyDelta < -6) out.push({ code: 'louder' })
  else if (energyDelta > 6) out.push({ code: 'quieter' })

  if (!c.pitchMeasured) {
    // Hangi tarafın ölçülemediğini ayırt ediyoruz: arka planı müzikli bir
    // klipte referansın perdesi çıkmıyor ve bu kullanıcının hatası değil.
    out.push({ code: c.refVoicedFrames < 5 ? 'refPitchUnmeasurable' : 'userPitchUnmeasurable' })
  } else if (c.pitch < 70) {
    // Genlik uyarısını yalnızca perde skoru zaten düşükken veriyoruz: skor 99
    // iken "tonlaman düz kaldı" demek kullanıcıya çelişkili geliyordu.
    const spreadRatio = pitchSpread(c.userPitch) / Math.max(0.5, pitchSpread(c.refPitch))
    if (spreadRatio < 0.5) out.push({ code: 'flatIntonation' })
    else if (spreadRatio > 2) out.push({ code: 'wobblyIntonation' })
    else out.push({ code: 'intonationShapeOff' })
  }

  if (out.length > 0) return out

  // Hiçbir kural tetiklenmediyse en zayıf eksene göre yönlendir; yoksa
  // "ters tonlama" gibi durumlarda düşük skorla birlikte "birebir" diyorduk.
  if (c.total >= 85) return [{ code: 'veryClose' }]
  const axes: Array<[number, FeedbackCode]> = [
    [c.timing, 'improveTiming'],
    [c.energy, 'improveEnergy'],
    [c.pitch, 'improvePitch'],
  ]
  axes.sort((a, b) => a[0] - b[0])
  return [{ code: axes[0][1] }]
}
