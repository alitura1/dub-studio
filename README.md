# Dub Studio

***English** · [Türkçe](README.tr.md)*

> **What is this?** An independent, open-source clone inspired by the browser
> dubbing game at [choicervoicer.games](https://choicervoicer.games/). It is not
> affiliated with that site in any way; all code and content here were written
> from scratch. The original game of the same name, "The Choicer Voicer", was
> published on itch.io by
> [YeahMaybe](https://yeahmaybe.itch.io/the-choicer-voicer).

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

**Recording** captures raw PCM through an AudioWorklet and writes WAV.
MediaRecorder is deliberately not used: `decodeAudioData` cannot decode its
WebM/Opus output, so takes were recorded but never scoreable.

**Export** renders the mix sample-accurately with `OfflineAudioContext`;
ffmpeg.wasm only swaps the container (`-c:v copy`). Because the video stream is
never re-encoded, a 26-second clip muxes in about two seconds.

**Original audio while you speak** — three modes:

- `Mute completely` (default) — the original is cut for the duration of the line
- `Suppress voice, keep music` — stereo centre cancellation (L−R); dialogue sits
  in the centre so it disappears, music and effects survive. Falls back to muting
  with a warning if the source is dual mono
- `Just duck it` — the original stays audible underneath at 12%

## Transcription

Whisper (transformers.js) runs in the browser; audio is never uploaded, only the
model files are fetched once from huggingface.co and cached.

On clean speech the result is word-perfect — all five lines of the demo pack come
out exactly. **It is unreliable on film clips with loud background music**, where
Whisper hallucinates instead of transcribing (things like "I'm sorry."). For those
clips, type the line texts by hand in the Studio.

**Timestamps are not line boundaries.** Whisper returns contiguous spans that
cover the whole audio: on the demo clip its first chunk claims "0.00–5.44" while
the speech actually runs 1.00–4.35. So boundaries always come from the
energy-based `segmentLines`, and Whisper only supplies text; the two are matched
by overlap (`src/features/transcribe/apply.ts`).

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
- Studio upload limits: 3 minutes / 150 MB (browser memory).

## Deploying

The output is static; publish `dist/` as-is (Vercel, Cloudflare Pages, Netlify,
GitHub Pages…). No COOP/COEP headers are required since SharedArrayBuffer is not
used.

```bash
npm run build
```

## License

MIT — see [LICENSE](LICENSE).
