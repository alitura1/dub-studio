import { useT } from '../../i18n/index.tsx'
import type { MessageKey } from '../../i18n/messages.ts'
import type { Feedback, ScoreBreakdown } from './score.ts'

export function scoreClass(total: number): string {
  if (total >= 75) return 'score-good'
  if (total >= 50) return 'score-mid'
  return 'score-bad'
}

function Axis({ label, value, measured = true }: { label: string; value: number; measured?: boolean }) {
  return (
    <div className="axis">
      <span className="muted">{label}</span>
      <span className="axis-bar">
        <span style={{ transform: `scaleX(${measured ? value / 100 : 0})` }} />
      </span>
      <span className="mono" style={{ textAlign: 'right' }}>
        {measured ? value : '—'}
      </span>
    </div>
  )
}

/**
 * Skor motoru kod döndürüyor, metni burada üretiyoruz.
 * Eski kayıtlarda düz metin saklanmış olabilir; onları olduğu gibi gösteriyoruz.
 */
function feedbackText(item: Feedback | string, t: ReturnType<typeof useT>): string {
  if (typeof item === 'string') return item
  return t(`fb.${item.code}` as MessageKey, item.ms !== undefined ? { ms: item.ms } : undefined)
}

export function ScoreCard({ score }: { score: ScoreBreakdown }) {
  const t = useT()
  const tone = score.total >= 75 ? 'good' : score.total >= 50 ? 'warn' : 'bad'

  return (
    <div className="card score-card">
      <div className="score-top">
        <div>
          <div className="score-total" style={{ color: `var(--${tone})` }}>
            {score.total}
          </div>
          <div className="faint" style={{ fontSize: 12 }}>
            {t('score.of100')}
          </div>
        </div>
        <div className="score-axes">
          <Axis label={t('score.timing')} value={score.timing} />
          <Axis label={t('score.energy')} value={score.energy} />
          <Axis label={t('score.pitch')} value={score.pitch} measured={score.pitchMeasured} />
        </div>
      </div>

      {score.feedback.length > 0 && (
        <ul className="feedback">
          {score.feedback.map((item, i) => (
            <li key={i}>{feedbackText(item, t)}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
