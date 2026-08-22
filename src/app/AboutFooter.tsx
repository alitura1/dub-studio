import { TransLink, useT } from '../i18n/index.tsx'

export const REPO_URL = 'https://github.com/alitura1/dub-studio'
const CHOICER_VOICER_URL = 'https://choicervoicer.games/'
const ORIGINAL_GAME_URL = 'https://yeahmaybe.itch.io/the-choicer-voicer'

/**
 * Kaynağı açıkça belirten alt bilgi.
 *
 * Bu proje choicervoicer.games'in bağımsız bir klonu; ne o siteyle ne de
 * aynı ismi taşıyan özgün itch.io oyunuyla bir bağı var. Bunu arayüzde
 * söylemek, yalnızca README'de bırakmaktan daha dürüst.
 */
export function AboutFooter() {
  const t = useT()
  return (
    <footer className="about">
      <div className="about-inner">
        <strong>{t('about.title')}</strong>
        <p>
          <TransLink text={t('about.clone')} href={CHOICER_VOICER_URL} />
        </p>
        <p>
          <TransLink text={t('about.original')} href={ORIGINAL_GAME_URL} />
        </p>
        <p>
          <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
            {t('about.source')} ↗
          </a>
        </p>
      </div>
    </footer>
  )
}
