/**
 * Final miksi tarayıcıda üretir.
 *
 * Ses tarafını OfflineAudioContext yapıyor (hızlı, örnek-doğru), ffmpeg.wasm
 * yalnızca kapsayıcıyı değiştiriyor — video akışı `-c:v copy` ile aynen
 * kopyalanıyor. Video'yu yeniden kodlamak wasm'da 20 saniyelik bir klipte
 * dakikalar sürerdi; kopyalama saniyeler alıyor.
 */

import { encodeWavPcm16 } from '../../lib/audio/wav.ts'
import { bufferChannels } from '../../lib/audio/context.ts'

export interface MixTake {
  startMs: number
  buffer: AudioBuffer
  gain: number
}

/**
 * Sen konuşurken orijinal sese ne olacak?
 *
 * `duck`  — kısılır ama duyulur. Orijinal oyuncunun sesi altta kalıyor ve
 *           dublajla çakışıyor; iyi bir varsayılan değil.
 * `mute`  — replik boyunca tamamen susar. Orijinal ses gider ama müzik ve
 *           ortam sesi de gider, sahnede boşluk hissi oluşur.
 * `removeVocals` — stereo merkez kanalı iptal edilir (L−R). Sinema sesinde
 *           diyalog neredeyse her zaman tam ortada, müzik ve efektler yanlara
 *           yayılmış olduğu için orijinal replik büyük ölçüde kaybolur,
 *           arka plan yaşamaya devam eder. Mono kaynakta uygulanamaz.
 */
export type OriginalMode = 'duck' | 'mute' | 'removeVocals'

export interface MixOptions {
  original: AudioBuffer
  takes: MixTake[]
  /** Orijinal sese müdahale edilecek aralıklar (replikler). */
  duckRanges: Array<{ startMs: number; endMs: number }>
  originalMode?: OriginalMode
  /** Yalnızca `duck` modunda: replik sırasındaki seviye. */
  duckLevel?: number
  /** Orijinal sesin replik dışındaki seviyesi. */
  originalLevel?: number
  durationMs?: number
}

const RAMP_S = 0.08 // ani kesme "tık" sesi yapıyor; 80 ms rampa temiz geçiyor

/** Stereo merkezi iptal eden düğüm zinciri (L−R). Çıkış monodur. */
export function buildCenterRemoved(ctx: BaseAudioContext, source: AudioNode): AudioNode {
  const splitter = ctx.createChannelSplitter(2)
  source.connect(splitter)
  const sum = ctx.createGain()
  const left = ctx.createGain()
  left.gain.value = 1
  const right = ctx.createGain()
  right.gain.value = -1
  splitter.connect(left, 0)
  splitter.connect(right, 1)
  // Aynı düğüme bağlanan sinyaller Web Audio'da toplanır: L + (−R) = L − R
  left.connect(sum)
  right.connect(sum)
  return sum
}

/**
 * Merkez iptalinin bu kaynakta işe yarayıp yaramayacağını ölçer.
 *
 * Yan sinyalin (L−R) tam sinyale göre kaç dB altında kaldığını döner.
 * Kaynak gerçekten mono ya da "dual-mono" ise (iki kanal birebir aynı) fark
 * sıfırdır: vokal bastırma sessizlik üretir, müzik de gider. YouTube'dan
 * gelen pek çok klip dual-mono olduğu için bunu önceden bilmek gerekiyor.
 * Dönüş -40 dB'den küçükse mod kullanılamaz sayılmalı.
 */
export function sideEnergyDb(buffer: AudioBuffer): number {
  if (buffer.numberOfChannels < 2) return -Infinity
  const left = buffer.getChannelData(0)
  const right = buffer.getChannelData(1)
  const n = Math.min(left.length, right.length)
  if (n === 0) return -Infinity
  // Uzun kliplerde her örneği taramak gereksiz; seyrek örnekleme yeterli
  const step = Math.max(1, Math.floor(n / 200_000))
  let sideSum = 0
  let midSum = 0
  let count = 0
  for (let i = 0; i < n; i += step) {
    const side = (left[i] - right[i]) / 2
    const mid = (left[i] + right[i]) / 2
    sideSum += side * side
    midSum += mid * mid
    count++
  }
  if (count === 0 || midSum === 0) return -Infinity
  return 20 * Math.log10(Math.sqrt(sideSum / count) / Math.sqrt(midSum / count) || 1e-9)
}

export const SIDE_ENERGY_FLOOR_DB = -40

export async function renderMix(options: MixOptions): Promise<AudioBuffer> {
  const { original, takes, duckRanges } = options
  const originalLevel = options.originalLevel ?? 1
  // Kaynak mono ya da dual-mono ise merkez iptali sessizlik üretir;
  // kullanıcıya boş bir parça vermektense susturmaya düşüyoruz.
  const mode: OriginalMode =
    options.originalMode === 'removeVocals' && sideEnergyDb(original) < SIDE_ENERGY_FLOOR_DB
      ? 'mute'
      : options.originalMode ?? 'mute'
  const duckLevel = mode === 'duck' ? options.duckLevel ?? 0.12 : 0

  const sampleRate = original.sampleRate
  const durationS = Math.max(
    original.duration,
    (options.durationMs ?? 0) / 1000,
    ...takes.map((t) => t.startMs / 1000 + t.buffer.duration),
  )

  const ctx = new OfflineAudioContext(2, Math.ceil(durationS * sampleRate), sampleRate)
  const ranges = [...duckRanges].sort((a, b) => a.startMs - b.startMs)

  /** Replik dışında `outside`, replik içinde `inside` değerini alan otomasyon. */
  const automate = (gain: GainNode, outside: number, inside: number) => {
    gain.gain.setValueAtTime(outside, 0)
    for (const range of ranges) {
      const start = Math.max(0, range.startMs / 1000 - RAMP_S)
      const end = Math.min(durationS, range.endMs / 1000)
      gain.gain.setValueAtTime(outside, start)
      gain.gain.linearRampToValueAtTime(inside, Math.min(end, start + RAMP_S))
      gain.gain.setValueAtTime(inside, Math.max(start + RAMP_S, end - RAMP_S))
      gain.gain.linearRampToValueAtTime(outside, Math.min(durationS, end + RAMP_S))
    }
  }

  const originalSource = ctx.createBufferSource()
  originalSource.buffer = original
  const mainGain = ctx.createGain()
  automate(mainGain, originalLevel, duckLevel)
  originalSource.connect(mainGain).connect(ctx.destination)
  originalSource.start(0)

  if (mode === 'removeVocals') {
    // İkinci bir kaynak: aynı tampon, merkezi iptal edilmiş hâli. Replik
    // dışında sessiz, replik boyunca açık — yani ana yolun tam tersi.
    const sideSource = ctx.createBufferSource()
    sideSource.buffer = original
    const sideGain = ctx.createGain()
    automate(sideGain, 0, originalLevel)
    buildCenterRemoved(ctx, sideSource).connect(sideGain).connect(ctx.destination)
    sideSource.start(0)
  }

  // Kullanıcı take'leri
  for (const take of takes) {
    const source = ctx.createBufferSource()
    source.buffer = take.buffer
    const gain = ctx.createGain()
    gain.gain.value = take.gain
    source.connect(gain).connect(ctx.destination)
    source.start(Math.max(0, take.startMs / 1000))
  }

  return ctx.startRendering()
}

export function audioBufferToWav(buffer: AudioBuffer): Uint8Array {
  return encodeWavPcm16(bufferChannels(buffer), buffer.sampleRate)
}

export interface MuxProgress {
  (stage: string, ratio: number): void
}

let ffmpegPromise: Promise<import('@ffmpeg/ffmpeg').FFmpeg> | null = null

/**
 * ffmpeg.wasm'ı tembel yükler. Çekirdek ~30 MB; oyunu oynamak için gerekmediği
 * için ilk dışa aktarma isteğine kadar hiç indirilmiyor.
 */
async function loadFfmpeg(onProgress?: MuxProgress) {
  if (ffmpegPromise) return ffmpegPromise
  ffmpegPromise = (async () => {
    onProgress?.('ffmpeg', 0)
    const { FFmpeg } = await import('@ffmpeg/ffmpeg')
    // Çekirdek public/ffmpeg/ altından servis ediliyor (scripts/ffmpeg-kopyala.mjs);
    // @ffmpeg/core paketi derin import'lara izin vermiyor.
    const base = `${window.location.origin}${import.meta.env.BASE_URL}ffmpeg/`
    const ffmpeg = new FFmpeg()
    // Tek iş parçacıklı çekirdek: SharedArrayBuffer gerektirmiyor, dolayısıyla
    // COOP/COEP başlıkları olmadan da (statik hosting dahil) çalışıyor.
    await ffmpeg.load({
      coreURL: `${base}ffmpeg-core.js`,
      wasmURL: `${base}ffmpeg-core.wasm`,
    })
    return ffmpeg
  })()
  return ffmpegPromise
}

/**
 * Videonun görüntüsünü aynen koruyup ses akışını yeni miksle değiştirir.
 *
 * Dikkat: ffmpeg.wasm giriş dizilerini worker'a *transfer* ediyor, yani
 * çağrıdan sonra `video` ve `wav` tamponları boşalıyor. Tekrar gerekiyorsa
 * çağıran taraf yeniden üretmeli.
 */
export async function muxToMp4(
  video: Uint8Array,
  wav: Uint8Array,
  onProgress?: MuxProgress,
): Promise<Uint8Array> {
  const ffmpeg = await loadFfmpeg(onProgress)

  const handler = ({ progress }: { progress: number }) => onProgress?.('muxing', progress)
  ffmpeg.on('progress', handler)

  try {
    onProgress?.('preparing', 0)
    await ffmpeg.writeFile('in.mp4', video)
    await ffmpeg.writeFile('mix.wav', wav)

    const code = await ffmpeg.exec([
      '-i', 'in.mp4',
      '-i', 'mix.wav',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      'out.mp4',
    ])
    if (code !== 0) throw new Error(`ffmpeg ${code} koduyla çıktı`)

    const data = await ffmpeg.readFile('out.mp4')
    onProgress?.('done', 1)
    return data as Uint8Array
  } finally {
    ffmpeg.off('progress', handler)
    for (const f of ['in.mp4', 'mix.wav', 'out.mp4']) {
      await ffmpeg.deleteFile(f).catch(() => {})
    }
  }
}

export function downloadBlob(data: Uint8Array | Blob, filename: string): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: 'video/mp4' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
