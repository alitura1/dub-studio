/**
 * Bir paketin oynatma için gereken her şeyini yükler:
 * pack.json, video URL'si ve skorlamada hedef olarak kullanılan referans PCM.
 *
 * Hazır paketlerde referans ayrı bir ref.wav dosyası (CLI üretiyor); kullanıcı
 * projelerinde böyle bir dosya yok, o yüzden videonun kendi sesinden çıkarıyoruz.
 */

import { useEffect, useState } from 'react'
import { decodeWav } from '../../lib/audio/wav.ts'
import { ANALYSIS_RATE, resampleLinear, toMono } from '../../lib/audio/resample.ts'
import { decodeAudio, toAnalysisPcm } from '../../lib/audio/context.ts'
import { fetchPack } from '../../lib/packs.ts'
import { loadProject } from '../../lib/store.ts'
import type { Pack } from '../../lib/pack.ts'

export interface PackData {
  pack: Pack
  videoUrl: string
  /** 16 kHz mono, klibin tamamı. */
  refPcm: Float32Array
  /**
   * Ayrıştırılmış arka plan (müzik + ortam, diyalog çıkarılmış).
   * Paket ayrıştırma içermiyorsa null — o zaman yaklaşık modlara düşülür.
   */
  background: AudioBuffer | null
  /** Dışa aktarmada ham video baytlarını almak için. */
  fetchVideoBytes: () => Promise<Uint8Array>
}

export function usePackData(packId: string, local: boolean, project: boolean) {
  const [data, setData] = useState<PackData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    let objectUrl: string | null = null
    setData(null)
    setError(null)

    async function load(): Promise<PackData> {
      if (project) {
        const stored = await loadProject(packId)
        if (!stored) throw new Error('Proje bulunamadı — silinmiş olabilir.')
        objectUrl = URL.createObjectURL(stored.video)
        const bytes = new Uint8Array(await stored.video.arrayBuffer())
        const refPcm = toAnalysisPcm(await decodeAudio(bytes.buffer.slice(0) as ArrayBuffer))
        return {
          pack: stored.pack,
          videoUrl: objectUrl,
          refPcm,
          // Kullanıcı projelerinde ayrıştırma yok: demucs paket üretim adımında
          background: null,
          fetchVideoBytes: async () => new Uint8Array(await stored.video.arrayBuffer()),
        }
      }

      const base = `${import.meta.env.BASE_URL}packs/${local ? 'yerel/' : ''}${packId}/`
      const pack = await fetchPack(base)
      const videoUrl = base + pack.video

      const wavRes = await fetch(base + pack.reference)
      if (!wavRes.ok) throw new Error(`Referans ses yüklenemedi (${wavRes.status})`)
      const wav = decodeWav(new Uint8Array(await wavRes.arrayBuffer()))
      const refPcm = resampleLinear(toMono(wav.channels), wav.sampleRate, ANALYSIS_RATE)

      let background: AudioBuffer | null = null
      if (pack.background) {
        try {
          const res = await fetch(base + pack.background)
          if (res.ok) background = await decodeAudio(await res.arrayBuffer())
        } catch {
          // Arka plan olmadan da oynanabilir; yaklaşık modlara düşülür
        }
      }

      return {
        pack,
        videoUrl,
        refPcm,
        background,
        fetchVideoBytes: async () => {
          const res = await fetch(videoUrl)
          if (!res.ok) throw new Error(`Video indirilemedi (${res.status})`)
          return new Uint8Array(await res.arrayBuffer())
        },
      }
    }

    load()
      .then((d) => {
        if (alive) setData(d)
        else if (objectUrl) URL.revokeObjectURL(objectUrl)
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))

    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [packId, local, project])

  return { data, error }
}
