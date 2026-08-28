import { useCallback, useEffect, useRef, useState } from 'react'
import type { Pack } from '../../lib/pack.ts'
import type { StoredTake } from '../../lib/store.ts'
import { audioContext, decodeAudio, resumeAudio } from '../../lib/audio/context.ts'
import type { PackData } from '../player/usePackData.ts'
import { useT } from '../../i18n/index.tsx'
import type { MessageKey } from '../../i18n/messages.ts'
import {
  audioBufferToWav,
  downloadBlob,
  muxToMp4,
  renderMix,
  sideEnergyDb,
  SIDE_ENERGY_FLOOR_DB,
  type OriginalMode,
} from './mix.ts'

interface Props {
  pack: Pack
  data: PackData
  activeTakeFor: (lineId: string) => StoredTake | null
  /** Oynatıcıyla paylaşılıyor: önizlemede duyulan, dosyaya da yazılan mod. */
  originalMode: OriginalMode
  onOriginalModeChange: (mode: OriginalMode) => void
}

type Stage = { label: string; ratio: number } | null

/** `stems` yalnızca paket gerçek ayrıştırma içeriyorsa listeleniyor. */
const ORIGINAL_MODES: OriginalMode[] = ['stems', 'mute', 'removeVocals', 'duck']

export function ExportPanel({ pack, data, activeTakeFor, originalMode, onOriginalModeChange }: Props) {
  const t = useT()
  const [stage, setStage] = useState<Stage>(null)
  const [error, setError] = useState<string | null>(null)
  /** Kaynağın vokal bastırmaya uygun olup olmadığı — ilk mikste öğreniliyor. */
  const [stereoWarning, setStereoWarning] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)

  /**
   * Final miksi videoyu oynatmadan dinletir.
   *
   * Dublajda kontrol edilmek istenen şey görüntü değil ses: replik doğru yere
   * mi oturdu, arka planla dengesi tuttu mu. Video açıkken bunu duymak
   * zorlaşıyor.
   */
  const previewAudio = useCallback(async () => {
    if (sourceRef.current) {
      sourceRef.current.stop()
      sourceRef.current = null
      setPlaying(false)
      return
    }
    setError(null)
    try {
      await resumeAudio()
      const mixed = await renderMixed()
      setStage(null)
      const ctx = audioContext()
      const source = ctx.createBufferSource()
      source.buffer = mixed
      source.connect(ctx.destination)
      source.onended = () => {
        sourceRef.current = null
        setPlaying(false)
      }
      source.start()
      sourceRef.current = source
      setPlaying(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStage(null)
    }
  }, [])

  useEffect(() => () => sourceRef.current?.stop(), [])
  const [wavFallback, setWavFallback] = useState<Uint8Array | null>(null)

  const recorded = pack.lines.filter((l) => activeTakeFor(l.id))
  const fileBase = pack.id || 'dublaj'

  /** Final miksi üretir. Hem dinletme hem dışa aktarma bunu kullanıyor. */
  async function renderMixed(): Promise<AudioBuffer> {
    setStage({ label: t('export.stage.audio'), ratio: 0.1 })
    const videoBytes = await data.fetchVideoBytes()
    const original = await decodeAudio(videoBytes.buffer.slice(0) as ArrayBuffer)

    setStereoWarning(
      originalMode === 'removeVocals' && sideEnergyDb(original) < SIDE_ENERGY_FLOOR_DB
        ? t('export.dualMono')
        : null,
    )

    const takes = []
    for (const line of pack.lines) {
      const take = activeTakeFor(line.id)
      if (!take) continue
      const buffer = await decodeAudio(await take.blob.arrayBuffer())
      takes.push({
        // Kayıt geri sayımda başladığı için take, repliğin başından leadTrimMs
        // kadar önce yerleştirilmeli — aksi halde sözler geç düşüyor.
        startMs: Math.max(0, line.startMs - take.leadTrimMs),
        buffer,
        gain: 1,
      })
    }

    setStage({ label: t('export.stage.mixing'), ratio: 0.3 })
    return renderMix({
      original,
      background: data.background,
      takes,
      duckRanges: recorded.map((l) => ({ startMs: l.startMs, endMs: l.endMs })),
      originalMode,
      durationMs: pack.durationMs,
    })
  }

  async function buildMixWav(): Promise<Uint8Array> {
    return audioBufferToWav(await renderMixed())
  }

  async function exportVideo() {
    setError(null)
    setWavFallback(null)
    try {
      const wav = await buildMixWav()
      const videoBytes = await data.fetchVideoBytes()
      const out = await muxToMp4(videoBytes, wav, (stageKey, ratio) =>
        setStage({ label: t(`export.stage.${stageKey}` as MessageKey), ratio: 0.4 + ratio * 0.6 }),
      )
      downloadBlob(out, `${fileBase}-dublaj.mp4`)
      setStage(null)
    } catch (err) {
      console.error(err)
      setError(t('export.failed', { error: err instanceof Error ? err.message : String(err) }))
      // ffmpeg.wasm bellek yetmezliğinde düşebiliyor; en azından sesi kurtaralım
      try {
        setWavFallback(await buildMixWav())
      } catch {
        /* miks de alınamadıysa gösterecek bir şey yok */
      }
      setStage(null)
    }
  }

  async function exportAudioOnly() {
    setError(null)
    try {
      const wav = await buildMixWav()
      downloadBlob(new Blob([wav as BlobPart], { type: 'audio/wav' }), `${fileBase}-dublaj.wav`)
      setStage(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStage(null)
    }
  }

  return (
    <div className="card" style={{ marginTop: 16, padding: 16 }}>
      <div className="row">
        <strong>{t('export.title')}</strong>
        <span className="faint" style={{ fontSize: 13 }}>
          {t('export.recordedCount', { done: recorded.length, total: pack.lines.length })}
        </span>
        <button
          className="btn btn-primary btn-sm"
          style={{ marginLeft: 'auto' }}
          onClick={exportVideo}
          disabled={recorded.length === 0 || stage !== null}
        >
          {stage ? t('export.preparing') : t('export.downloadMp4')}
        </button>
        <button className="btn btn-sm" onClick={previewAudio} disabled={recorded.length === 0 || stage !== null}>
          {playing ? t('export.stopAudio') : t('export.previewAudio')}
        </button>
        <button className="btn btn-sm" onClick={exportAudioOnly} disabled={recorded.length === 0 || stage !== null}>
          {t('export.audioOnly')}
        </button>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <label className="faint" style={{ fontSize: 13 }}>
          {t('export.originalLabel')}{' '}
          <select
            value={originalMode}
            onChange={(e) => onOriginalModeChange(e.target.value as OriginalMode)}
            disabled={stage !== null}
          >
            {ORIGINAL_MODES.filter((m) => m !== 'stems' || data.background).map((m) => (
              <option key={m} value={m}>
                {t(`export.mode.${m}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <span className="faint" style={{ fontSize: 12 }}>
          {t(`export.mode.${originalMode}.hint` as MessageKey)}
        </span>
      </div>

      {stereoWarning && (
        <div className="notice" style={{ marginTop: 12 }}>
          {stereoWarning}
        </div>
      )}

      {stage && (
        <div style={{ marginTop: 12 }}>
          <div className="progress">
            <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, stage.ratio))})` }} />
          </div>
          <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
            {stage.label}
            {stage.label === t('export.stage.ffmpeg') && t('export.ffmpegNote')}
          </div>
        </div>
      )}

      {error && (
        <div className="notice notice-bad" style={{ marginTop: 12 }}>
          {error}
          {wavFallback && (
            <>
              {' '}
              <button
                className="btn btn-sm"
                onClick={() =>
                  downloadBlob(new Blob([wavFallback as BlobPart], { type: 'audio/wav' }), `${fileBase}-dublaj.wav`)
                }
              >
                {t('export.downloadWav')}
              </button>
            </>
          )}
        </div>
      )}

      {recorded.length === 0 && (
        <div className="faint" style={{ fontSize: 13, marginTop: 8 }}>
          {t('export.needOneTake')}
        </div>
      )}
    </div>
  )
}
