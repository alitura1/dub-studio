/**
 * ffmpeg.wasm çekirdeğini public/ffmpeg/ altına kopyalar.
 *
 * @ffmpeg/core paketi `exports` haritasıyla derin import'ları kapatıyor, bu
 * yüzden `@ffmpeg/core/dist/esm/...?url` şeklinde alamıyoruz. Dosyaları
 * statik varlık olarak servis etmek hem dev'de hem Cloudflare Pages'te
 * aynı şekilde çalışıyor ve wasm'ı bundle'a sokmuyor.
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Paketin `exports` haritası `./package.json`'ı bile dışa vermiyor, bu yüzden
 * require.resolve ile bulamıyoruz. ESM koşulunu çözen import.meta.resolve
 * çalışıyor; olmazsa doğrudan node_modules yoluna düşüyoruz.
 */
function findCoreDir() {
  try {
    return dirname(fileURLToPath(import.meta.resolve('@ffmpeg/core')))
  } catch {
    const fallback = join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm')
    if (existsSync(fallback)) return fallback
    throw new Error('@ffmpeg/core bulunamadı — `npm install` çalıştır.')
  }
}

const coreDir = findCoreDir()
const outDir = join(root, 'public', 'ffmpeg')

mkdirSync(outDir, { recursive: true })

let copied = 0
for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  const from = join(coreDir, name)
  const to = join(outDir, name)
  // Değişmediyse dokunma: her dev başlangıcında 32 MB kopyalamanın anlamı yok
  try {
    if (statSync(to).size === statSync(from).size) continue
  } catch {
    /* hedef yok, kopyala */
  }
  copyFileSync(from, to)
  copied++
}

if (copied > 0) console.log(`ffmpeg çekirdeği kopyalandı (${copied} dosya) → public/ffmpeg/`)
