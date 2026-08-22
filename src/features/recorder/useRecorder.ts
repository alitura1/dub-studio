/**
 * Mikrofon kaydı.
 *
 * MediaRecorder yerine AudioWorklet ile ham PCM topluyoruz. Sebebi somut:
 * MediaRecorder'ın WebM/Opus çıktısını `decodeAudioData` çözemiyor
 * ("EncodingError: Unable to decode audio data"), yani kayıt alınıyor ama
 * puanlanamıyor ve dışa aktarılamıyordu. Ham PCM'i kendimiz WAV'a yazınca
 * hem skorlama girdisi doğrudan elimizde oluyor hem de üretilen dosyayı
 * her tarayıcı sorunsuz çalıyor. Codec uyumluluk matrisi de tamamen kalkıyor.
 *
 * Hizalama: kayıt geri sayımdan sonra, replikten biraz önce başlıyor.
 * Repliğin başladığı anda o ana kadar gelen örnek sayısını işaretleyip
 * baştan kırpıyoruz — böylece "erken/geç girdin" ölçümü tarayıcı
 * gecikmesini değil kullanıcının gerçek zamanlamasını gösteriyor.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { audioContext, resumeAudio } from '../../lib/audio/context.ts'
import { encodeWavPcm16 } from '../../lib/audio/wav.ts'

export type RecorderState = 'idle' | 'arming' | 'ready' | 'recording' | 'denied'

export interface RecordingResult {
  /** WAV (PCM16) — her yerde çözülebilir. */
  blob: Blob
  /** Ham örnekler; skorlama bunu doğrudan kullanıyor, tekrar çözmeye gerek yok. */
  pcm: Float32Array
  sampleRate: number
  /** Kayıt başlangıcı ile replik başlangıcı arasındaki fark (ms). */
  leadTrimMs: number
}

const WORKLET_SOURCE = `
class MicTap extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input[0]) this.port.postMessage(new Float32Array(input[0]))
    return true
  }
}
registerProcessor('mic-tap', MicTap)
`

let workletUrl: string | null = null
function getWorkletUrl(): string {
  if (!workletUrl) {
    workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
  }
  return workletUrl
}

export function useRecorder() {
  const [state, setState] = useState<RecorderState>('idle')
  const [level, setLevel] = useState(0)
  /** Çeviri anahtarı; metni gösteren taraf üretiyor. */
  const [error, setError] = useState<'mic.denied' | 'mic.unavailable' | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const sampleCountRef = useRef(0)
  const markSampleRef = useRef<number | null>(null)
  const capturingRef = useRef(false)
  const rafRef = useRef<number | null>(null)
  const moduleLoadedRef = useRef(false)

  const stopMeter = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    setLevel(0)
  }, [])

  /** İzin ister, worklet'i bağlar, seviye ölçeri başlatır. İzin yalnızca burada isteniyor. */
  const arm = useCallback(async (): Promise<boolean> => {
    if (streamRef.current && workletRef.current) {
      setState('ready')
      return true
    }
    setState('arming')
    setError(null)
    try {
      await resumeAudio()
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      })
      streamRef.current = stream

      const ctx = audioContext()
      if (!moduleLoadedRef.current) {
        await ctx.audioWorklet.addModule(getWorkletUrl())
        moduleLoadedRef.current = true
      }

      const source = ctx.createMediaStreamSource(stream)
      sourceRef.current = source

      const worklet = new AudioWorkletNode(ctx, 'mic-tap')
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!capturingRef.current) return
        chunksRef.current.push(event.data)
        sampleCountRef.current += event.data.length
      }
      source.connect(worklet)
      // Worklet çıkış üretmiyor ama bazı tarayıcılar bağlanmamış düğümü
      // işlemeyi bırakıyor; sessiz bir kazançla hedefe bağlıyoruz.
      const sink = ctx.createGain()
      sink.gain.value = 0
      worklet.connect(sink).connect(ctx.destination)
      workletRef.current = worklet

      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)

      const data = new Float32Array(analyser.fftSize)
      const tick = () => {
        analyser.getFloatTimeDomainData(data)
        let sum = 0
        for (const v of data) sum += v * v
        setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4))
        rafRef.current = requestAnimationFrame(tick)
      }
      tick()

      setState('ready')
      return true
    } catch (err) {
      console.error('Mikrofon hazırlanamadı', err)
      setState('denied')
      setError(
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'mic.denied'
          : 'mic.unavailable',
      )
      return false
    }
  }, [])

  const start = useCallback(async (): Promise<boolean> => {
    if (!workletRef.current && !(await arm())) return false
    if (!workletRef.current) return false
    chunksRef.current = []
    sampleCountRef.current = 0
    markSampleRef.current = null
    capturingRef.current = true
    setState('recording')
    return true
  }, [arm])

  /** Videonun replik başlangıcına geldiği anı işaretler (hizalama için). */
  const markLineStart = useCallback(() => {
    if (markSampleRef.current === null) markSampleRef.current = sampleCountRef.current
  }, [])

  const stop = useCallback(async (): Promise<RecordingResult | null> => {
    if (!capturingRef.current) return null
    capturingRef.current = false
    setState('ready')

    const sampleRate = audioContext().sampleRate
    const total = sampleCountRef.current
    const pcm = new Float32Array(total)
    let offset = 0
    for (const chunk of chunksRef.current) {
      pcm.set(chunk, offset)
      offset += chunk.length
    }
    chunksRef.current = []

    if (total === 0) return null

    const markSample = markSampleRef.current ?? 0
    return {
      blob: new Blob([encodeWavPcm16([pcm], sampleRate) as BlobPart], { type: 'audio/wav' }),
      pcm,
      sampleRate,
      leadTrimMs: (markSample / sampleRate) * 1000,
    }
  }, [])

  const release = useCallback(() => {
    stopMeter()
    capturingRef.current = false
    workletRef.current?.disconnect()
    sourceRef.current?.disconnect()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    workletRef.current = null
    sourceRef.current = null
    streamRef.current = null
    setState('idle')
  }, [stopMeter])

  useEffect(() => release, [release])

  return { state, level, error, arm, start, stop, markLineStart, release }
}
