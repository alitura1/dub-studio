/**
 * Paylaşılan AudioContext ve çözme yardımcıları.
 *
 * Tek bir context tutuyoruz: tarayıcılar sayfa başına açılabilecek context
 * sayısını sınırlıyor ve her kayıtta yenisini açmak Safari'de sessizce
 * çalışmayı durduruyor.
 */

import { ANALYSIS_RATE, resampleLinear, toMono } from './resample.ts'

let ctx: AudioContext | null = null

export function audioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

/** Tarayıcılar ses çıkışını ilk kullanıcı etkileşimine kadar askıya alır. */
export async function resumeAudio(): Promise<void> {
  const c = audioContext()
  if (c.state === 'suspended') await c.resume()
}

export async function decodeAudio(data: ArrayBuffer): Promise<AudioBuffer> {
  // decodeAudioData bazı tarayıcılarda ArrayBuffer'ı tükettiği için kopya veriyoruz
  return audioContext().decodeAudioData(data.slice(0))
}

export function bufferChannels(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))
}

/** AudioBuffer'ı skorlama zincirinin beklediği 16 kHz mono PCM'e indirger. */
export function toAnalysisPcm(buffer: AudioBuffer): Float32Array {
  return resampleLinear(toMono(bufferChannels(buffer)), buffer.sampleRate, ANALYSIS_RATE)
}

export async function blobToAnalysisPcm(blob: Blob): Promise<Float32Array> {
  return toAnalysisPcm(await decodeAudio(await blob.arrayBuffer()))
}
