import { useCallback, useRef, useState } from 'react'
import type { Pack, PackLine } from '../../lib/pack.ts'
import { buildLinesFromTranscript, fillLineTexts } from './apply.ts'
import {
  DEFAULT_MODEL,
  transcribe,
  WHISPER_MODELS,
  type TranscribeProgress,
  type TranscriptSegment,
} from './whisper.ts'
import { useT, type Translate } from '../../i18n/index.tsx'
import type { MessageKey } from '../../i18n/messages.ts'

interface Props {
  pack: Pack
  /** Klibin tamamı, 16 kHz mono. */
  pcm: Float32Array
  onApply: (lines: PackLine[]) => void
}

/** Whisper'ın desteklediği dillerden bir seçki; boş = otomatik algıla. */
const SPEECH_LANGS = ['', 'tr', 'en', 'de', 'es', 'ar'] as const

const LANG_NAMES: Record<string, string> = {
  tr: 'Türkçe',
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  ar: 'العربية',
}

/** Modülden gelen aşama kodunu metne çevirir; bilinmeyen kodu olduğu gibi gösterir. */
function translateStage(stage: string, t: Translate, file?: string): string {
  const known = ['download', 'ready', 'analyzing', 'done']
  if (!known.includes(stage)) return stage
  return t(`tx.stage.${stage}` as MessageKey, { file: file ?? '' })
}

export function TranscribePanel({ pack, pcm, onApply }: Props) {
  const t = useT()
  const [model, setModel] = useState<string>(DEFAULT_MODEL)
  const [language, setLanguage] = useState('')
  const [progress, setProgress] = useState<TranscribeProgress | null>(null)
  const [segments, setSegments] = useState<TranscriptSegment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const runningRef = useRef(false)

  const run = useCallback(async () => {
    if (runningRef.current) return
    runningRef.current = true
    setError(null)
    setSegments(null)
    setProgress({ stage: t('tx.starting'), ratio: -1 })
    try {
      const result = await transcribe(pcm, {
        model,
        language: language || undefined,
        onProgress: (p) => setProgress({ ...p, stage: translateStage(p.stage, t, p.file) }),
      })
      setSegments(result)
      if (result.length === 0) setError(t('tx.noSpeech'))
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      runningRef.current = false
      setProgress(null)
    }
  }, [pcm, model, language, t])

  const totalText = segments?.map((s) => s.text).join(' ') ?? ''

  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="row">
        <strong>{t('tx.title')}</strong>
        <span className="badge" title={t('tx.badgeTitle')}>
          {t('tx.badge')}
        </span>
        <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={run} disabled={!!progress}>
          {progress ? t('tx.running') : t('tx.run')}
        </button>
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <label className="faint" style={{ fontSize: 13 }}>
          {t('tx.model')}{' '}
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!!progress}>
            {WHISPER_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {t(`tx.model.${m.size}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="faint" style={{ fontSize: 13 }}>
          {t('tx.language')}{' '}
          <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={!!progress}>
            {SPEECH_LANGS.map((l) => (
              <option key={l} value={l}>
                {l ? LANG_NAMES[l] : t('tx.langAuto')}
              </option>
            ))}
          </select>
        </label>
      </div>

      {progress && (
        <div style={{ marginTop: 12 }}>
          <div className="progress">
            <span
              style={{
                transform: `scaleX(${progress.ratio >= 0 ? Math.min(1, progress.ratio) : 1})`,
                opacity: progress.ratio >= 0 ? 1 : 0.4,
              }}
            />
          </div>
          <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
            {progress.stage}
            {progress.ratio < 0 && t('tx.slowHint')}
          </div>
        </div>
      )}

      {error && (
        <div className="notice notice-bad" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}

      {segments && segments.length > 0 && (
        <>
          <div className="faint" style={{ fontSize: 12, margin: '14px 0 6px' }}>
            {t('tx.foundParts', { n: segments.length })}
          </div>
          <div
            style={{
              maxHeight: 160,
              overflowY: 'auto',
              fontSize: 13,
              background: 'var(--bg-sunken)',
              borderRadius: 8,
              padding: 10,
            }}
          >
            {segments.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: 8 }}>
                <span className="mono faint" style={{ flexShrink: 0 }}>
                  {(s.startMs / 1000).toFixed(1)}s
                </span>
                <span>{s.text}</span>
              </div>
            ))}
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="btn btn-sm"
              onClick={() => onApply(fillLineTexts(pack.lines, segments))}
              title={t('tx.fillTextsTitle')}
            >
              {t('tx.fillTexts')}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() =>
                onApply(buildLinesFromTranscript(pcm, segments, pack.characters, pack.durationMs))
              }
              title={t('tx.rebuildTitle')}
            >
              {t('tx.rebuild')}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => navigator.clipboard?.writeText(totalText)}
              style={{ marginLeft: 'auto' }}
            >
              {t('tx.copy')}
            </button>
          </div>
        </>
      )}

      <div className="faint" style={{ fontSize: 12, marginTop: 10 }}>
        {t('tx.privacy')}
      </div>
    </div>
  )
}
