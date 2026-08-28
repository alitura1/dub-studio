# Dub Studio

***English** · [Türkçe](README.tr.md)*

> **What is this?** An independent, open-source clone inspired by the browser
> dubbing game at [choicervoicer.games](https://choicervoicer.games/). It is not
> affiliated with that site in any way; all code and content here were written
> from scratch. The original game of the same name, "The Choicer Voicer", was
> published on itch.io by
> [YeahMaybe](https://yeahmaybe.itch.io/the-choicer-voicer).

**Live: https://dub-studio-eight.vercel.app**

A dubbing game that runs entirely in the browser: pick a clip, perform each line
into your microphone, get scored on timing, delivery and intonation, then
download the result as an MP4.

No server. Audio and video never leave your device — the mix and the final MP4
are produced in the browser.

## Running it

```bash
npm install
npm run dev
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server (http://localhost:5273) |
| `npm run build` | Type-check + production build (`dist/`) |
| `npm test` | Scoring-engine tests |
| `npm run kontrol` | Type-check only |
| `npm run paket -- …` | Build a dubbing pack from a clip (see below) |

## The bundled demo

`public/packs/sorgu-odasi/` — a 14.5-second two-hander interrogation scene, five
lines. Entirely synthetic: the speech is Windows SAPI text-to-speech, the visuals
and the background pad are ffmpeg. No third-party content, so it is safe to
redistribute.

The dialogue is deliberately panned dead centre and the pad hard left/right, so
the **Suppress voice, keep music** mode is clearly audible on this clip: during a
line the original speech is cancelled from −17 dB while the music stays put.

## Building packs

A browser cannot pull video from YouTube directly (CORS + terms of service), so
URL import runs through a local CLI instead of a server.

```bash
# From a URL (requires yt-dlp: pip install -U yt-dlp)
npm run paket -- "https://youtu.be/xxxx" --bas 1:12 --sure 20 --ad "Scene name" --yerel

# From a local file
npm run paket -- --dosya "C:\clips\scene.mp4" --ad "Test scene"
```

The tool normalises the clip to 720p H.264 + AAC, extracts a 16 kHz mono
`ref.wav`, finds line boundaries from silence, and writes `pack.json`. Line texts
start empty — fill them in via **Your video → Transcribe** in the app, or type
them by hand.

### `--yerel` and copyright

`--yerel` writes the pack to `public/packs/yerel/`, which is git-ignored and never
deployed. Put TV and film clips there. Anything under `public/packs/` **is**
distributed, so only place content you hold the rights to.

## How it works

**Scoring** (`src/features/scoring/score.ts`) measures three independent axes:

| Axis | Weight | Measurement |
| --- | --- | --- |
| Timing | 35% | DTW path deviation from the diagonal + onset difference |
| Energy | 30% | Correlation of the aligned RMS envelopes |
| Intonation | 35% | Confidence-weighted correlation of median-centred YIN pitch contours |

Absolute pitch is ignored on purpose: a deep voice imitating a line an octave
lower is not making a mistake. What is scored is the *shape* of the contour. When
pitch cannot be measured (loud background music), the score is re-weighted across
the remaining two axes and the user is told so explicitly.

**While you record**, the line's reference envelope is drawn as a target shape
and your microphone is traced over it in real time, on the same axis. Both are
normalised to their own peak, so what you are matching is the shape — timing and
emphasis — not how loud you happen to be. The trace stays on screen afterwards so
you can compare the take against the reference before deciding to keep it.

**Recording** captures raw PCM through an AudioWorklet and writes WAV.
MediaRecorder is deliberately not used: `decodeAudioData` cannot decode its
WebM/Opus output, so takes were recorded but never scoreable.

**Export** renders the mix sample-accurately with `OfflineAudioContext`;
ffmpeg.wasm only swaps the container (`-c:v copy`). Because the video stream is
never re-encoded, a 26-second clip muxes in about two seconds.

The moment a line starts is marked from a timer as well as from
`requestAnimationFrame`: rAF is suspended in a background tab while the video
keeps playing, which used to leave the take recorded but misaligned.

**Original audio while you speak** — four modes:

- `Remove the character voice, keep the music` (default when available) — plays
  the real background stem separated at pack build time. The other three are
  approximations; this one is not. Measured on a music-heavy clip: the original
  line sits at −22.6 dB, the stem replaces it at −33.4 dB, which is the level the
  music holds between lines (−34.6 dB). Whisper finds no speech at all in the
  background stem
- `Mute completely` — the original is cut, but so are music and ambience
- `Suppress voice, keep music` — stereo centre cancellation (L−R). Falls back to
  muting with a warning on dual-mono sources
- `Just duck it` — the original stays audible underneath at 12%

The background stem also plays **while you record**, so you perform over the
music instead of into silence. It contains no dialogue, so nothing leaks into
the microphone.

**♪ Preview audio** renders the same mix and plays it without the video — when
you are checking a dub, what matters is whether the line landed, not the picture.

## Separation and transcription

Packs are built locally, so the heavy work happens there rather than in the
browser. `demucs --two-stems=vocals` splits the clip into dialogue and
background; the CLI keeps the background as `background.m4a` and the isolated
dialogue as the scoring reference. `faster-whisper` then transcribes with word
timestamps, and the lines are built from those.

Both are optional: without `demucs` the pack still builds (approximation modes
only), and without `faster-whisper` the line texts stay empty for you to type.

```bash
pip install demucs faster-whisper
```

Measured on a 25-second music-heavy clip, CPU: separation 43 s, transcription
12 s, whole pack build about 2.5 minutes including download and encode. The
first run also downloads the demucs model (~4 min).

> Separation was measured to help less than expected in two places. It made
> energy-based line boundaries *worse*, and transcribing the isolated dialogue
> gave essentially the same text as the full mix — the transcription win came
> from the larger model, not from separation. Where it does deliver is its actual
> job: taking the original voice out from under your dub.

### In the browser

Whisper (transformers.js) still runs in the browser for videos you upload
yourself; audio is never uploaded, only the model files are fetched once from
huggingface.co and cached.

On clean speech the result is word-perfect — all five lines of the demo pack come
out exactly. **It is unreliable on film clips with loud background music**, where
Whisper hallucinates instead of transcribing (things like "I'm sorry."). For those
clips, type the line texts by hand in the Studio.

**Lines come from word timestamps, not from audio energy.** This was measured,
not assumed: on a music-heavy clip the energy segmenter produced 4-6 second
blobs, because it derives its threshold from the noise floor and music lifts that
floor. Whisper's word timings gave the actual lines in the same audio
("Don't come any closer." 2.14-2.90). Groups are split on sentence-ending
punctuation and on pauses, and any group still longer than four seconds is split
again at its widest internal gap — a 5.5-second line cannot be performed in one
breath.

**Segment timestamps are not line boundaries.** Whisper returns contiguous spans that
cover the whole audio: on the demo clip its first chunk claims "0.00–5.44" while
the speech actually runs 1.00–4.35. Boundaries therefore always come from the
energy-based `segmentLines`; Whisper only supplies text.

**Text is placed word by word.** Giving each line "the chunk it overlaps most"
wrote the *same* text into every line a long chunk spanned — the duplicates you
would see on a dense scene. Placement now uses word-level timestamps: each word
lands in exactly one line, chosen by its own midpoint, so duplication is
structurally impossible. This needs a model exported with cross attentions —
the plain `onnx-community/whisper-base` fails with "Model outputs must contain
cross attentions", which is why the `_timestamped` variants are the default.
If a model cannot produce word timings, the code falls back to a greedy
one-to-one chunk assignment that also never reuses a chunk
(`src/features/transcribe/apply.ts`).

Speed is roughly real time for `base` on WASM (14.9 s for a 14.5 s clip, warm),
so the panel shows an estimate before you start on anything over a minute.

> - `q8` quantisation cannot create a session on the current onnxruntime-web;
>   the default is `q4`.
> - The default execution target is WASM. WebGPU gave no measurable win at these
>   clip sizes (13.0 s vs 13.8 s) and crashed the tab once; enable it with
>   `device: 'webgpu'` if you want it.

## Languages

The interface ships in English and Turkish. The language follows the browser,
can be switched from the top bar, and the choice is stored in `localStorage`.

Every string lives in [`src/i18n/messages.ts`](src/i18n/messages.ts). A missing
key in either language is a compile error, so a translation cannot be forgotten.
The scoring engine returns feedback as codes rather than prose
(`{ code: 'late', ms: 320 }`) and the UI translates them — that keeps the DSP
layer unaware of language.

## Known issues

- ffmpeg.wasm's core is ~32 MB. It is copied into `public/ffmpeg/` after
  `npm install` (`scripts/ffmpeg-kopyala.mjs`), kept out of the repo, and only
  downloaded on the first export.
- Studio upload limits: 10 minutes / 500 MB. Editing stays responsive, but past
  about five minutes the MP4 export can get slow or run out of memory — the whole
  mix is rendered in an `OfflineAudioContext` before ffmpeg.wasm sees it. The app
  warns you at that point rather than blocking.

## Deploying

The output is static; publish `dist/` as-is (Vercel, Cloudflare Pages, Netlify,
GitHub Pages…). No COOP/COEP headers are required since SharedArrayBuffer is not
used.

```bash
npm run build
```

## License

MIT — see [LICENSE](LICENSE).
