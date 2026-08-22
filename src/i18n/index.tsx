/**
 * Dil bağlamı ve çeviri fonksiyonu.
 *
 * Kütüphane kullanmıyoruz: iki dil, tek düzlemsel sözlük ve `{isim}`
 * yer tutucusundan ibaret bir ihtiyaç için i18next taşımak fazlalık olurdu.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { LANGUAGES, MESSAGES, type Lang, type MessageKey } from './messages.ts'

const STORAGE_KEY = 'dublaj-dil'

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

interface LangContextValue {
  lang: Lang
  setLang: (lang: Lang) => void
  t: Translate
}

const LangContext = createContext<LangContextValue | null>(null)

function isLang(value: unknown): value is Lang {
  return value === 'tr' || value === 'en'
}

/** Kayıtlı tercih → tarayıcı dili → İngilizce. */
export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (isLang(saved)) return saved
  } catch {
    /* gizli sekmede localStorage kapalı olabilir */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language : ''
  return nav.toLowerCase().startsWith('tr') ? 'tr' : 'en'
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang)

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    document.documentElement.lang = next
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* yoksay */
    }
  }, [])

  const t = useCallback<Translate>(
    (key, params) => {
      const template = MESSAGES[lang][key] ?? MESSAGES.en[key] ?? key
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in params ? String(params[name]) : match,
      )
    },
    [lang],
  )

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t])
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>
}

export function useLang(): LangContextValue {
  const ctx = useContext(LangContext)
  if (!ctx) throw new Error('LangProvider gerekli')
  return ctx
}

/** Sık kullanım için kısayol. */
export function useT(): Translate {
  return useLang().t
}

export function LanguageSwitcher() {
  const { lang, setLang, t } = useLang()
  return (
    <select
      className="lang-select"
      value={lang}
      onChange={(e) => setLang(e.target.value as Lang)}
      aria-label={t('nav.language')}
    >
      {LANGUAGES.map((l) => (
        <option key={l.id} value={l.id}>
          {l.label}
        </option>
      ))}
    </select>
  )
}

/**
 * İçinde tek bir `<a>` yer tutucusu olan metni bağlantıyla birlikte basar.
 * Çeviri metnine ham HTML gömmemek için: `dangerouslySetInnerHTML` yerine
 * metni parçalayıp gerçek bir React elemanı yerleştiriyoruz.
 */
export function TransLink({ text, href }: { text: string; href: string }) {
  const open = text.indexOf('<a>')
  const close = text.indexOf('</a>')
  if (open < 0 || close < open) return <>{text}</>
  return (
    <>
      {text.slice(0, open)}
      <a href={href} target="_blank" rel="noreferrer noopener">
        {text.slice(open + 3, close)}
      </a>
      {text.slice(close + 4)}
    </>
  )
}

export type { Lang, MessageKey }
