/**
 * Tarayıcıda konuşma tanıma (Whisper / transformers.js).
 *
 * Replik metinlerini elle yazmak yerine sesten çıkarıyoruz. İki iş birden
 * yapıyor: metin *ve* zaman damgaları — yani enerji tabanlı satır bölmenin
 * yerine gerçek konuşma sınırları geçebiliyor.
 *
 * Tamamen istemci tarafında: ses hiçbir yere gönderilmiyor, yalnızca model
 * dosyaları huggingface.co'dan bir kez indirilip tarayıcı önbelleğinde kalıyor.
 * Bu yüzden ilk çalıştırma yavaş, sonrakiler hızlı.
 */

import { ANALYSIS_RATE } from '../../lib/audio/resample.ts'

export interface TranscriptSegment {
  startMs: number
  endMs: number
  text: string
}

export interface TranscribeProgress {
  /**
   * Çeviri anahtarı ya da hazır metin. Modül arayüzün dilini bilmediği için
   * kod döndürüyor; gösteren taraf çeviriyor (`translateStage`).
   */
  stage: string
  /** İndirilen dosyanın adı gibi ek bilgiler. */
  file?: string
  /** 0..1; belirsizse -1. */
  ratio: number
}

export interface TranscribeOptions {
  /** 'tr', 'en' … Boş bırakılırsa Whisper kendi tespit eder. */
  language?: string
  model?: string
  /** Modelin ONNX kuantizasyonu; her repo her dtype'ı desteklemiyor. */
  dtype?: WhisperDtype
  /** WebGPU varsa çok daha hızlı; yoksa WASM'a düşülür. */
  device?: 'auto' | 'wasm' | 'webgpu'
  onProgress?: (p: TranscribeProgress) => void
  signal?: AbortSignal
}

/** Küçük model hızlı ama daha çok hata yapıyor; base gündelik kullanım için iyi denge. */
export const WHISPER_MODELS = [
  { id: 'onnx-community/whisper-tiny', size: 'tiny' },
  { id: 'onnx-community/whisper-base', size: 'base' },
  { id: 'onnx-community/whisper-small', size: 'small' },
] as const

export type WhisperDtype = 'auto' | 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16'

export const DEFAULT_MODEL = 'onnx-community/whisper-base'

/**
 * q8 bu onnxruntime-web sürümünde oturum açamıyor
 * ("Missing required scale ... DequantizeLinear"), q4 hem çalışıyor hem
 * fp32'den belirgin hızlı ve küçük.
 */
export const DEFAULT_DTYPE: WhisperDtype = 'q4'

type Transcriber = (audio: Float32Array, options: Record<string, unknown>) => Promise<unknown>

export function hasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

const cache = new Map<string, Promise<Transcriber>>()

async function getTranscriber(
  model: string,
  dtype: WhisperDtype,
  device: 'auto' | 'wasm' | 'webgpu',
  onProgress?: (p: TranscribeProgress) => void,
): Promise<Transcriber> {
  const cacheKey = `${model}|${dtype}|${device}`
  const existing = cache.get(cacheKey)
  if (existing) return existing

  const promise = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers')
    // Yerel model klasörümüz yok; doğrudan hub'dan çeksin
    env.allowLocalModels = false

    return (await pipeline('automatic-speech-recognition', model, {
      dtype,
      device,
      progress_callback: (info: { status?: string; progress?: number; file?: string }) => {
        if (info.status === 'progress' && typeof info.progress === 'number') {
          onProgress?.({ stage: 'download', file: info.file ?? '', ratio: info.progress / 100 })
        } else if (info.status === 'ready') {
          onProgress?.({ stage: 'ready', ratio: 1 })
        }
      },
    })) as unknown as Transcriber
  })()

  cache.set(cacheKey, promise)
  // Başarısız yükleme önbellekte kalmasın, kullanıcı tekrar deneyebilsin
  promise.catch(() => cache.delete(cacheKey))
  return promise
}

interface WhisperChunk {
  timestamp: [number, number | null]
  text: string
}

/**
 * 16 kHz mono PCM'i metne çevirir.
 * Zaman damgası üretemeyen parçalar atlanır — sınırı olmayan bir replik
 * kaydedilemez, dolayısıyla listede işimize yaramaz.
 */
export async function transcribe(
  pcm: Float32Array,
  options: TranscribeOptions = {},
): Promise<TranscriptSegment[]> {
  const model = options.model ?? DEFAULT_MODEL
  /*
   * Varsayılan WASM. WebGPU teoride daha hızlı ama bu klip boyutlarında
   * ölçülebilir bir kazanç vermedi (13.0 sn'ye karşı 13.8 sn) ve bir denemede
   * sekmeyi tamamen düşürdü. Kullanıcının oturumunu kaybettirme riskine
   * karşılık kazanç yok; isteyen `device` ile açabilir.
   */
  const device = options.device ?? 'wasm'
  const transcriber = await getTranscriber(
    model,
    options.dtype ?? DEFAULT_DTYPE,
    device,
    options.onProgress,
  )

  options.onProgress?.({ stage: 'analyzing', ratio: -1 })
  const result = (await transcriber(pcm, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    task: 'transcribe',
    ...(options.language ? { language: options.language } : {}),
  })) as { text?: string; chunks?: WhisperChunk[] }

  const chunks = result.chunks ?? []
  const totalMs = (pcm.length / ANALYSIS_RATE) * 1000

  const segments: TranscriptSegment[] = []
  for (const chunk of chunks) {
    const text = (chunk.text ?? '').trim()
    if (!text) continue
    const [start, end] = chunk.timestamp
    if (typeof start !== 'number') continue
    const startMs = Math.max(0, start * 1000)
    // Whisper son parçanın bitişini bazen null bırakıyor; klip sonuna dayıyoruz
    const endMs = Math.min(totalMs, typeof end === 'number' ? end * 1000 : totalMs)
    if (endMs - startMs < 120) continue
    segments.push({ startMs, endMs, text })
  }

  options.onProgress?.({ stage: 'done', ratio: 1 })
  return segments
}

/** Bir metni, zaman aralığı en çok örtüşen replikle eşleştirir. */
export function overlapMs(a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }): number {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs))
}
