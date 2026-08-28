/**
 * Paket üretici CLI.
 *
 *   npm run paket -- "https://youtu.be/..." --bas 1:12 --sure 20 --ad "Homelander — Delicious" --yerel
 *   npm run paket -- --dosya "C:\klipler\sahne.mp4" --ad "Test sahnesi"
 *
 * Tarayıcı YouTube'dan doğrudan video çekemez (CORS + ToS), bu yüzden URL
 * içe aktarma burada, senin makinende çalışıyor. Sunucu gerekmiyor.
 *
 * Satır sınırlarını uygulamanın kullandığı segment.ts ile buluyoruz —
 * CLI'nin ürettiği paket, Studio'da göreceğin şeyle birebir aynı olsun diye.
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { segmentLines } from '../src/lib/audio/segment.ts'
import { decodeWav } from '../src/lib/audio/wav.ts'
import { toMono } from '../src/lib/audio/resample.ts'
import { linesFromWords } from '../src/features/transcribe/apply.ts'
import type { TranscriptWord } from '../src/features/transcribe/whisper.ts'
import {
  CHARACTER_COLORS,
  PACK_SCHEMA_VERSION,
  slugify,
  type Pack,
  type PackIndexEntry,
  type PackLine,
} from '../src/lib/pack.ts'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PACKS_PUBLIC = join(ROOT, 'public', 'packs')
const PACKS_LOCAL = join(PACKS_PUBLIC, 'yerel')

interface Args {
  url?: string
  file?: string
  startMs: number
  durationMs?: number
  title?: string
  id?: string
  local: boolean
  characters: number
  help: boolean
  /** Ayrıştırma ve transkripsiyonu atla (hızlı deneme için). */
  skipSeparate: boolean
  skipText: boolean
  /** faster-whisper model boyutu. */
  whisperModel: string
  /** Konuşma dili; boş bırakılırsa Whisper tespit eder. */
  speechLang?: string
}

function parseTime(value: string): number {
  const parts = value.split(':').map((p) => Number(p))
  if (parts.some((p) => !isFinite(p))) throw new Error(`Geçersiz zaman: ${value}`)
  const seconds = parts.reduce((acc, p) => acc * 60 + p, 0)
  return Math.round(seconds * 1000)
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    startMs: 0,
    local: false,
    characters: 1,
    help: false,
    skipSeparate: false,
    skipText: false,
    whisperModel: 'small',
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} bir değer bekliyor`)
      return v
    }
    /**
     * npm run, Windows'ta tırnakları düşürüp `--ad "İki Kelime"` argümanını
     * ikiye bölüyor. Serbest metin alan seçeneklerde bir sonraki seçeneğe
     * kadarki tüm parçaları topluyoruz.
     */
    const nextPhrase = () => {
      const parts = [next()]
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) parts.push(argv[++i])
      return parts.join(' ')
    }
    switch (a) {
      case '--dosya': args.file = next(); break
      case '--bas': args.startMs = parseTime(next()); break
      case '--sure': args.durationMs = Math.round(Number(next()) * 1000); break
      case '--ad': args.title = nextPhrase(); break
      case '--id': args.id = next(); break
      case '--yerel': args.local = true; break
      case '--karakter': args.characters = Math.max(1, Number(next()) || 1); break
      case '--ayirma-yok': args.skipSeparate = true; break
      case '--metin-yok': args.skipText = true; break
      case '--model': args.whisperModel = next(); break
      case '--konusma-dili': args.speechLang = next(); break
      case '--yardim': case '-h': case '--help': args.help = true; break
      default:
        if (a.startsWith('-')) throw new Error(`Bilinmeyen seçenek: ${a}`)
        args.url = a
    }
  }
  return args
}

const HELP = `
Choicer Voicer paket üretici

Kullanım:
  npm run paket -- <url> [seçenekler]
  npm run paket -- --dosya <yol> [seçenekler]

Seçenekler:
  --bas <mm:ss>     Klibin kaynaktaki başlangıcı (varsayılan 0)
  --sure <saniye>   Klip süresi (varsayılan: tamamı, URL'de zorunlu)
  --ad "<başlık>"   Paket başlığı
  --id <slug>       Klasör adı (varsayılan: başlıktan türetilir)
  --karakter <n>    Kaç karakter tanımlansın (satırlar sırayla dağıtılır)
  --yerel           public/packs/yerel/ altına yaz (gitignore'lu, deploy edilmez)
  --konusma-dili    Replik dili (en, tr…); boş bırakılırsa tespit edilir
  --model           faster-whisper modeli (tiny/base/small/medium; varsayılan small)
  --ayirma-yok      demucs ile müzik/diyalog ayrıştırmasını atla
  --metin-yok       transkripsiyonu atla, replik metinleri boş kalsın

Örnek:
  npm run paket -- "https://youtu.be/xxxx" --bas 1:12 --sure 18 --ad "Homelander — Delicious" --yerel
`

/**
 * Çalıştırılabilirin tam yolunu PATH üzerinde arar.
 *
 * İki tuzağı birden atlatıyor:
 *  - `shell: true` Windows'ta argümanları tırnaklamıyor, "C:\Users\Ali Tura
 *    Çetin\..." gibi boşluklu yollar ikiye bölünüyor.
 *  - `where` çıktısını OEM kod sayfasında veriyor; Türkçe karakterli yollar
 *    UTF-8 olarak okununca bozuluyor.
 * process.env.PATH doğru kodlanmış geldiği için aramayı burada yapıp
 * komutları shell'siz çalıştırmak ikisini de çözüyor.
 */
const binCache = new Map<string, string | null>()

function resolveBin(name: string): string | null {
  if (binCache.has(name)) return binCache.get(name)!
  const isWin = process.platform === 'win32'
  const exts = ['', ...(isWin ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [])]
  const dirs = (process.env.PATH ?? '').split(isWin ? ';' : ':')
  let found: string | null = null
  search: for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase())
      if (existsSync(candidate)) {
        found = candidate
        break search
      }
    }
  }
  binCache.set(name, found)
  return found
}

/** ffmpeg ailesi `-version`, yt-dlp `--version` istiyor — bayrağı çağıran veriyor. */
function has(cmd: string, versionFlag = '--version'): boolean {
  const bin = resolveBin(cmd)
  if (!bin) return false
  return spawnSync(bin, [versionFlag], { stdio: 'ignore' }).status === 0
}

function exec(cmd: string, cmdArgs: string[]) {
  const bin = resolveBin(cmd)
  if (!bin) throw new Error(`${cmd} bulunamadı`)
  return spawnSync(bin, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
}

function run(cmd: string, cmdArgs: string[], label: string): void {
  process.stdout.write(`  ${label}...`)
  const r = exec(cmd, cmdArgs)
  if (r.status !== 0) {
    process.stdout.write(' ✗\n')
    const err = (r.stderr || r.stdout || '').split('\n').slice(-15).join('\n')
    throw new Error(`${label} başarısız (${cmd}):\n${err}`)
  }
  process.stdout.write(' ✓\n')
}

/**
 * Süreyi `ffmpeg -i` çıktısından okur.
 *
 * Bilerek ffprobe kullanmıyoruz: bu makinede ffmpeg başka bir uygulamanın
 * klasöründen geliyor ve yanında ffprobe yok. Tek ikiliye bağlı kalmak,
 * aracı taşınabilir de yapıyor. Bulunamazsa çağıran taraf WAV uzunluğuna düşer.
 */
function probeDurationMs(file: string): number | null {
  // Çıkış dosyası vermediğimiz için ffmpeg 1 ile çıkar; bizi ilgilendiren stderr.
  const r = exec('ffmpeg', ['-hide_banner', '-i', file])
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr || '')
  if (!match) return null
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
  return isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null
}

interface Stems {
  /** Diyalog, müzik/efekt çıkarılmış. */
  vocals: string
  /** Müzik + ortam, diyalog çıkarılmış. */
  background: string
}

/**
 * demucs ile diyaloğu müzikten ayırır.
 *
 * Ölçüldü (25 sn'lik müzikli klip, CPU): ayrıştırma 43 sn sürüyor, arka plan
 * parçasının seviyesi orijinalle aynı kalıyor (-16.0 dB / -16.1 dB) ve içinde
 * konuşma kalmıyor — Whisper arka plan parçasında replik bulamıyor. Yani
 * "sen konuşurken orijinal repliği sil, müziği bırak" tam olarak çalışıyor.
 *
 * demucs yoksa null döner; araç ayrıştırmasız da çalışmaya devam eder.
 */
function separateStems(clip: string, tmp: string): Stems | null {
  if (!has('demucs', '--help')) {
    console.log('  ! demucs yok, ayrıştırma atlanıyor (pip install demucs)')
    return null
  }
  const mix = join(tmp, 'mix.wav')
  run('ffmpeg', ['-y', '-i', clip, '-vn', '-ac', '2', '-ar', '44100', mix], 'Ses çıkarılıyor')

  const out = join(tmp, 'demucs')
  run(
    'demucs',
    ['--two-stems=vocals', '--filename', '{stem}.{ext}', '-o', out, mix],
    'Müzik ve diyalog ayrılıyor',
  )

  // demucs çıktıyı <out>/<model>/<stem>.wav olarak yazıyor
  const modelDir = readdirSync(out)[0]
  if (!modelDir) return null
  const vocals = join(out, modelDir, 'vocals.wav')
  const background = join(out, modelDir, 'no_vocals.wav')
  if (!existsSync(vocals) || !existsSync(background)) return null
  return { vocals, background }
}

/**
 * Replikleri konuşmadan çıkarır: hem metin hem sınırlar.
 *
 * Tarayıcıdaki whisper-base yerine faster-whisper: aynı müzikli klipte
 * tarayıcı modeli 26 saniyeye "I'm sorry." derken bu altı repliği de doğru
 * çıkardı. Sınırlar da buradan geliyor — enerji tabanlı bölme müziğin
 * gürültü tabanını yükseltmesi yüzünden 4-6 saniyelik bloklar üretiyordu.
 */
function transcribeWords(audio: string, args: Args): TranscriptWord[] {
  const script = join(ROOT, 'tools', 'transkript.py')
  const cmdArgs = [script, audio, '--model', args.whisperModel]
  if (args.speechLang) cmdArgs.push('--dil', args.speechLang)

  process.stdout.write('  Replikler yazıya dökülüyor...')
  const r = exec('python', cmdArgs)
  const line = (r.stdout || '').trim().split('\n').pop() ?? ''
  let parsed: { words?: TranscriptWord[]; error?: string }
  try {
    parsed = JSON.parse(line)
  } catch {
    process.stdout.write(' ✗\n')
    console.log('  ! transkripsiyon çıktısı okunamadı, metinler boş bırakılıyor')
    return []
  }
  if (parsed.error || !parsed.words) {
    process.stdout.write(' ✗\n')
    console.log(`  ! ${parsed.error ?? 'transkripsiyon başarısız'} — metinler boş bırakılıyor`)
    return []
  }
  process.stdout.write(` ✓ ${parsed.words.length} kelime\n`)
  return parsed.words
}

/** Kaynağı indirir/kopyalar ve normalize edilmiş clip.mp4 üretir. */
function buildClip(args: Args, tmp: string, outDir: string): void {
  const clip = join(outDir, 'clip.mp4')
  let source: string

  if (args.url) {
    if (!has('yt-dlp')) {
      throw new Error(
        'yt-dlp bulunamadı. Kurmak için:\n\n  pip install -U yt-dlp\n\n' +
          '(Alternatif: klibi elle indirip --dosya ile ver.)',
      )
    }
    if (args.durationMs === undefined) {
      throw new Error("URL kaynağında --sure zorunlu (örn: --sure 20). Tüm videoyu indirmek istemezsin.")
    }
    const startS = args.startMs / 1000
    const endS = startS + args.durationMs / 1000
    source = join(tmp, 'kaynak.mp4')
    run(
      'yt-dlp',
      [
        '-f', 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]/bv*+ba/b',
        '--download-sections', `*${startS}-${endS}`,
        '--force-keyframes-at-cuts',
        '--merge-output-format', 'mp4',
        '--no-playlist',
        '-o', source,
        args.url,
      ],
      'Kaynak indiriliyor',
    )
    // yt-dlp bölümü zaten kesti; ffmpeg'e baştan veriyoruz
    run(
      'ffmpeg',
      [
        '-y', '-i', source,
        '-t', String(args.durationMs / 1000),
        '-vf', 'scale=-2:720:flags=lanczos',
        '-r', '30',
        '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-movflags', '+faststart',
        clip,
      ],
      'Klip normalize ediliyor',
    )
  } else {
    source = resolve(args.file!)
    if (!existsSync(source)) throw new Error(`Dosya bulunamadı: ${source}`)
    const trim = ['-ss', String(args.startMs / 1000)]
    if (args.durationMs !== undefined) trim.push('-t', String(args.durationMs / 1000))
    run(
      'ffmpeg',
      [
        '-y', ...trim, '-i', source,
        '-vf', 'scale=-2:720:flags=lanczos',
        '-r', '30',
        '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-movflags', '+faststart',
        clip,
      ],
      'Klip normalize ediliyor',
    )
  }
}

function writeIndex(dir: string, entry: PackIndexEntry): void {
  const indexPath = join(dir, 'index.json')
  let entries: PackIndexEntry[] = []
  if (existsSync(indexPath)) {
    try {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf8'))
      if (Array.isArray(parsed)) entries = parsed
    } catch {
      console.warn('  ! Mevcut index.json okunamadı, yeniden oluşturuluyor')
    }
  }
  entries = entries.filter((e) => e.id !== entry.id)
  entries.push(entry)
  entries.sort((a, b) => a.title.localeCompare(b.title, 'tr'))
  writeFileSync(indexPath, JSON.stringify(entries, null, 2) + '\n', 'utf8')
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || (!args.url && !args.file)) {
    console.log(HELP)
    process.exit(args.help ? 0 : 1)
  }
  if (!has('ffmpeg', '-version')) {
    throw new Error('ffmpeg bulunamadı. https://ffmpeg.org adresinden kurup PATH\'e ekle.')
  }

  const title = args.title ?? (args.file ? basename(args.file).replace(/\.[^.]+$/, '') : 'Yeni paket')
  const id = slugify(args.id ?? title)
  const baseDir = args.local ? PACKS_LOCAL : PACKS_PUBLIC
  const outDir = join(baseDir, id)

  console.log(`\n▶ ${title}  (${id})`)
  console.log(`  hedef: ${outDir.replace(ROOT, '.')}\n`)

  mkdirSync(outDir, { recursive: true })
  const tmp = mkdtempSync(join(tmpdir(), 'cv-pack-'))

  try {
    buildClip(args, tmp, outDir)

    const clip = join(outDir, 'clip.mp4')
    const refWav = join(outDir, 'ref.wav')

    const stems = args.skipSeparate ? null : separateStems(clip, tmp)
    if (stems) {
      run(
        'ffmpeg',
        ['-y', '-i', stems.background, '-c:a', 'aac', '-b:a', '192k', join(outDir, 'background.m4a')],
        'Arka plan yazılıyor',
      )
    }

    /*
     * Skorlama referansı: ayrıştırma varsa temiz diyalog, yoksa tam miks.
     * Ayrılmış vokal üzerinde perde takibi müziğin melodisine değil konuşmaya
     * kilitleniyor — puanlanan şeyin doğru olması buna bağlı.
     */
    run(
      'ffmpeg',
      [
        '-y', '-i', stems?.vocals ?? clip,
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', refWav,
      ],
      'Referans ses çıkarılıyor',
    )

    const wav = decodeWav(new Uint8Array(readFileSync(refWav)))
    const pcm = toMono(wav.channels)

    const characters = Array.from({ length: args.characters }, (_, i) => ({
      id: `k${i + 1}`,
      name: `Karakter ${i + 1}`,
      color: CHARACTER_COLORS[i % CHARACTER_COLORS.length],
    }))

    const durationMs = probeDurationMs(clip) ?? Math.round((pcm.length / wav.sampleRate) * 1000)

    /*
     * Replikleri transkriptten kuruyoruz. Transkripsiyon tam miks üzerinde
     * çalışıyor: ölçümde ayrılmış vokalle neredeyse aynı metni verdi ("I'm
     * Jewish" → "Jewish" tek farkla, ayrılmış olan biraz daha kötüydü), yani
     * ayrıştırmaya bağlamanın kazancı yok.
     */
    let lines: PackLine[] = []
    if (!args.skipText) {
      const words = transcribeWords(clip, args)
      if (words.length > 0) lines = linesFromWords(words, characters, durationMs)
    }

    if (lines.length === 0) {
      // Transkript yoksa enerjiden bölüyoruz — metinler Studio'da doldurulur
      process.stdout.write('  Satırlar sesin enerjisinden bulunuyor...')
      const ranges = segmentLines(pcm, { sampleRate: wav.sampleRate })
      process.stdout.write(` ✓ ${ranges.length} satır\n`)
      lines = ranges.map((r, i) => ({
        id: `l${i + 1}`,
        characterId: characters[i % characters.length].id,
        startMs: Math.round(r.startMs),
        endMs: Math.round(r.endMs),
        text: '',
        leadInMs: 800,
      }))
    }

    const pack: Pack = {
      schemaVersion: PACK_SCHEMA_VERSION,
      id,
      title,
      video: 'clip.mp4',
      reference: 'ref.wav',
      background: stems ? 'background.m4a' : undefined,
      durationMs,
      characters,
      lines,
      source: args.url
        ? { kind: 'url', ref: args.url, startMs: args.startMs, durationMs: args.durationMs }
        : { kind: 'file', ref: basename(args.file!), startMs: args.startMs, durationMs: args.durationMs },
      local: args.local,
    }

    writeFileSync(join(outDir, 'pack.json'), JSON.stringify(pack, null, 2) + '\n', 'utf8')
    writeIndex(baseDir, {
      id,
      title,
      dir: args.local ? `yerel/${id}` : id,
      durationMs: pack.durationMs,
      lineCount: lines.length,
      local: args.local,
    })

    console.log(`\n✓ Paket hazır: ${lines.length} satır, ${(pack.durationMs / 1000).toFixed(1)} sn`)
    if (lines.length === 0) {
      console.log('  ! Hiç satır bulunamadı — klip sessiz olabilir. Studio\'da elle ekleyebilirsin.')
    } else {
      console.log('  Replik metinleri boş. Uygulamada Studio > bu paket > metinleri doldur.')
    }
    if (args.local) console.log('  Bu paket yerel: gitignore\'lu, deploy edilmiyor.')
    console.log()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

try {
  main()
} catch (err) {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
