import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5273 },
  build: { target: 'es2022' },
  // @ffmpeg/ffmpeg worker'ı önceden bundle edilmesin — lazy yüklüyoruz
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', '@huggingface/transformers'] },
})
