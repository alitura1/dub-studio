import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Yerel paketleri derleme çıktısından çıkarır.
 *
 * `public/packs/yerel/` .gitignore'lu, ama Vite `public/` altındaki her şeyi
 * `dist/`e kopyaladığı için telifli klipler derlemeye sızıyordu: repoya
 * girmiyorlar, yine de elle alınan bir `dist/` yayınında ortaya çıkıyorlardı.
 * "Yerel kalır" sözünün derleme için de geçerli olması gerekiyor.
 */
function excludeLocalPacks(): Plugin {
  return {
    name: 'yerel-paketleri-disla',
    apply: 'build',
    closeBundle() {
      const dir = resolve(__dirname, 'dist', 'packs', 'yerel')
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export default defineConfig({
  plugins: [react(), excludeLocalPacks()],
  server: { port: 5273 },
  build: { target: 'es2022' },
  // @ffmpeg/ffmpeg ve transformers tembel yükleniyor; önceden bundle edilmesin
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', '@huggingface/transformers'] },
})
