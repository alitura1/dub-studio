# Dublaj Stüdyosu

*[English](README.md) · **Türkçe***

> **Bu nedir?** Tarayıcıda çalışan dublaj oyunu
> [choicervoicer.games](https://choicervoicer.games/) sitesinden esinlenerek
> yazılmış, bağımsız ve açık kaynaklı bir klondur. O siteyle hiçbir bağı yoktur;
> kodun ve içeriğin tamamı sıfırdan üretilmiştir. Aynı ismi taşıyan özgün oyun
> "The Choicer Voicer", itch.io üzerinde
> [YeahMaybe](https://yeahmaybe.itch.io/the-choicer-voicer) tarafından
> yayınlanmıştır.

**Canlı: https://dub-studio-eight.vercel.app**

Tarayıcıda çalışan dublaj oyunu: bir klip seç, replikleri mikrofonla seslendir,
zamanlaman / vurgun / tonlaman referansla karşılaştırılıp puanlansın, sonucu MP4
olarak indir.

Sunucu yok. Ses ve video cihazdan çıkmıyor; miks ve MP4 üretimi tarayıcıda oluyor.

## Çalıştırma

```bash
npm install
npm run dev
```

| Komut | Ne yapar |
| --- | --- |
| `npm run dev` | Geliştirme sunucusu (http://localhost:5273) |
| `npm run build` | Tip kontrolü + üretim derlemesi (`dist/`) |
| `npm test` | Skor motoru testleri |
| `npm run kontrol` | Sadece tip kontrolü |
| `npm run paket -- …` | Klipten dublaj paketi üretir (aşağıda) |

## Hazır demo

`public/packs/sorgu-odasi/` — 14.5 saniyelik iki kişilik sorgu sahnesi, 5 replik.
Tamamı sentetik: konuşma Windows SAPI ile üretildi, görüntü ve arka plan müziği
ffmpeg ile. Hiçbir dış içerik yok, dolayısıyla dağıtılabilir.

Diyalog bilerek merkeze, arka plan pedi yanlara pan’lendi; böylece
**Sesi bastır, müziği koru** modu bu klipte gözle görülür çalışıyor: replik
sırasında konuşma −17 dB'den iptal oluyor, müzik yerinde kalıyor.

## Paket üretme

Tarayıcı YouTube'dan doğrudan video çekemez (CORS + ToS), bu yüzden URL içe
aktarma yerel bir CLI ile yapılıyor.

```bash
# URL'den (yt-dlp gerekir: pip install -U yt-dlp)
npm run paket -- "https://youtu.be/xxxx" --bas 1:12 --sure 20 --ad "Sahne adı" --yerel

# Yerel dosyadan
npm run paket -- --dosya "C:\klipler\sahne.mp4" --ad "Test sahnesi"
```

Araç klibi 720p H.264 + AAC'ye normalize eder, 16 kHz mono `ref.wav` çıkarır,
sessizlikten replik sınırlarını bulur ve `pack.json` yazar. Replik metinleri boş
gelir — uygulamada **Kendi videon → Transkript çıkar** ile doldurabilir ya da elle
yazabilirsin.

### `--yerel` ve telif

`--yerel` paketi `public/packs/yerel/` altına yazar; bu klasör `.gitignore`'lu ve
deploy edilmez. Dizi/film klipleri buraya. `public/packs/` altındakiler ise
dağıtılır — oraya yalnızca hakkına sahip olduğun içeriği koy.

## Nasıl çalışıyor

**Skor** (`src/features/scoring/score.ts`) üç bağımsız eksen ölçüyor:

| Eksen | Ağırlık | Ölçüm |
| --- | --- | --- |
| Zamanlama | %35 | DTW yolunun köşegenden sapması + ilk sesli çerçeve farkı |
| Enerji | %30 | Hizalanmış RMS zarflarının korelasyonu |
| Tonlama | %35 | Medyan-ortalanmış YIN perde konturunun güven ağırlıklı korelasyonu |

Mutlak perde bilerek yok sayılıyor: kalın sesli biri bir oktav aşağıdan taklit
ederse bu hata değil. Ölçülen şey konturun *şekli*. Perde ölçülemezse (arka plan
müziği baskınsa) skor kalan iki eksene göre yeniden ağırlıklandırılıyor ve bu
kullanıcıya açıkça söyleniyor.

**Kayıt sırasında** repliğin referans zarfı bir şablon olarak çiziliyor ve
mikrofonun aynı eksende, gerçek zamanlı olarak üzerine bindiriliyor. İki zarf da
kendi tepesine göre normalize ediliyor: eşleştirdiğin şey ses yüksekliği değil,
şekil — nerede başladığın, nerede vurguladığın. Kayıttan sonra çizim ekranda
kalıyor, take'i tutmadan önce referansla karşılaştırabiliyorsun.

**Kayıt** ham PCM olarak alınıyor (AudioWorklet), WAV'a yazılıyor. MediaRecorder
kullanılmıyor: WebM/Opus çıktısını `decodeAudioData` çözemediği için kayıtlar
puanlanamıyordu.

**Dışa aktarma** miksi `OfflineAudioContext` ile örnek-doğru üretiyor, ffmpeg.wasm
yalnızca kapsayıcıyı değiştiriyor (`-c:v copy`). Video yeniden kodlanmadığı için
26 saniyelik bir klip ~2 saniyede birleşiyor.

Repliğin başladığı an hem `requestAnimationFrame` hem de bir zamanlayıcıyla
işaretleniyor: sekme arka plana alındığında rAF duruyor ama video oynamaya devam
ediyor; eskiden bu durumda kayıt alınıyor ama hizalaması kayboluyordu.

**Sen konuşurken orijinal ses** dört moddan biri:

- `Karakterin sesini sil, müziği koru` (varsa varsayılan) — paket üretilirken
  ayrılmış gerçek arka plan parçası çalınır. Diğer üçü yaklaşıklama, bu değil.
  Müziği baskın bir klipte ölçüldü: orijinal replik −22.6 dB, yerine geçen parça
  −33.4 dB, ki bu müziğin replikler arasında tuttuğu seviye (−34.6 dB). Whisper
  arka plan parçasında hiç konuşma bulamıyor
- `Tamamen sustur` — orijinal kesilir ama müzik ve ortam da gider
- `Sesi bastır, müziği koru` — stereo merkez iptali (L−R). Dual-mono kaynakta
  uygulanamaz, uyarıyla susturmaya düşer
- `Sadece kıs` — orijinal %12 seviyede altta duyulur

Arka plan parçası **kayıt sırasında da** çalıyor: sessizliğe değil müziğin
üstüne oynuyorsun. İçinde diyalog olmadığı için mikrofona sızma da yok.

**♪ Sadece sesi dinle** aynı miksi üretip videosuz çalıyor — dublajı kontrol
ederken önemli olan görüntü değil, repliğin yerine oturup oturmadığı.

## Ayrıştırma ve transkripsiyon

Paketler yerel olarak üretildiği için ağır iş tarayıcıda değil orada yapılıyor.
`demucs --two-stems=vocals` klibi diyalog ve arka plan diye ayırıyor; CLI arka
planı `background.m4a`, ayrılmış diyaloğu da skorlama referansı olarak saklıyor.
Ardından `faster-whisper` kelime damgalarıyla yazıya döküyor ve replikler
bunlardan kuruluyor.

İkisi de opsiyonel: `demucs` yoksa paket yine kuruluyor (yalnızca yaklaşık
modlar), `faster-whisper` yoksa replik metinleri boş kalıyor.

```bash
pip install demucs faster-whisper
```

25 saniyelik müziği baskın bir klipte, CPU'da ölçüldü: ayrıştırma 43 sn,
transkripsiyon 12 sn, indirme ve kodlama dahil tüm paket üretimi ~2.5 dakika.
İlk çalıştırma ayrıca demucs modelini indiriyor (~4 dk).

> Ayrıştırmanın iki yerde beklenenden az fayda ettiği ölçüldü. Enerji tabanlı
> replik sınırlarını *kötüleştirdi*, ve ayrılmış diyaloğu yazıya dökmek tam
> miksle neredeyse aynı metni verdi — transkript kazancı ayrıştırmadan değil
> daha büyük modelden geliyordu. Asıl işini yaptığı yer belli: dublajının
> altından orijinal sesi çekmek.

### Tarayıcı tarafı

Whisper (transformers.js) kendi yüklediğin videolar için tarayıcıda çalışmaya
devam ediyor; ses hiçbir yere gönderilmiyor, yalnızca model dosyaları
huggingface.co'dan bir kez indirilip önbelleğe alınıyor.

Net kayıtta sonuç birebir doğru — demo paketin beş repliği de kelimesi kelimesine
çıkıyor. **Arka planında yüksek müzik olan film kliplerinde güvenilmez**; Whisper
konuşma yerine uydurma üretiyor ("I'm sorry." gibi). Bu klipler için replik
metinlerini Studio'da elle yazmak gerekiyor.

**Replikler kelime damgalarından kuruluyor, sesin enerjisinden değil.** Bu
varsayılmadı, ölçüldü: müziği baskın bir klipte enerji tabanlı bölme 4-6 saniyelik
bloklar üretti, çünkü eşiğini gürültü tabanından hesaplıyor ve müzik o tabanı
yukarı çekiyor. Aynı seste Whisper'ın kelime damgaları gerçek replikleri verdi
("Don't come any closer." 2.14-2.90). Gruplar cümle sonu noktalamasında ve
duraklarda bölünüyor; dört saniyeyi hâlâ aşan grup en geniş iç durağından tekrar
bölünüyor — 5.5 saniyelik bir replik tek nefeste seslendirilemiyor.

**Parça damgaları replik sınırı değil.** Whisper sesi baştan sona kaplayan bitişik
aralıklar döndürüyor: demo klipte ilk parçaya "0.00–5.44" diyor, oysa konuşma
1.00'da başlayıp 4.35'te bitiyor. Bu yüzden sınırlar her zaman enerji tabanlı
`segmentLines`'tan geliyor; Whisper yalnızca metni sağlıyor.

**Metin kelime kelime yerleştiriliyor.** Her repliğe "en çok örtüştüğü parça"yı
vermek, uzun bir parça birkaç repliği kapsadığında aynı metni hepsine yazıyordu —
yoğun sahnelerde gördüğün tekrarların sebebi buydu. Artık dağıtım kelime düzeyinde:
her kelime kendi orta noktasına göre *tek bir* repliğe düşüyor, tekrar üretmek
yapısal olarak imkânsız. Bunun için modelin cross-attention ile derlenmiş olması
gerekiyor; düz `onnx-community/whisper-base` "Model outputs must contain cross
attentions" hatası veriyor, bu yüzden varsayılan `_timestamped` varyantları.
Kelime damgası üretilemezse, parçaları birebir dağıtan ve hiçbir parçayı iki kez
kullanmayan yedek yola düşülüyor (`src/features/transcribe/apply.ts`).

Hız WASM üzerinde `base` için kabaca gerçek zaman (14.5 sn'lik klip ısınmış hâlde
14.9 sn), bu yüzden bir dakikadan uzun kliplerde panel önceden süre tahmini
gösteriyor.

> - `q8` kuantizasyonu mevcut onnxruntime-web sürümünde oturum açamıyor;
>   varsayılan `q4`.
> - Varsayılan çalıştırma hedefi WASM. WebGPU bu klip boyutlarında ölçülebilir
>   kazanç vermedi (13.0 sn'ye karşı 13.8 sn) ve bir denemede sekmeyi düşürdü;
>   isteyen `device: 'webgpu'` ile açabilir.

## Bilinen konular

- `npm audit`, `@huggingface/transformers`'ın **Node tarafı** bağımlılıkları
  (`onnxruntime-node`, `sharp`) için yüksek önem dereceli uyarı veriyor. Tarayıcı
  yolu WASM kullanıyor, bu paketler çalışma zamanında hiç yüklenmiyor; yine de
  transkripsiyona ihtiyacın yoksa bağımlılığı kaldırabilirsin.
- ffmpeg.wasm çekirdeği ~32 MB. `public/ffmpeg/` altına `npm install` sonrası
  kopyalanıyor (`scripts/ffmpeg-kopyala.mjs`), repoda tutulmuyor, ve yalnızca ilk
  dışa aktarmada indiriliyor.
- Studio'da yüklenen video sınırları: 10 dakika / 500 MB. Düzenleme akıcı kalıyor
  ama yaklaşık beş dakikadan sonra MP4 dışa aktarma yavaşlayabilir ya da bellek
  yetmeyebilir — miksin tamamı ffmpeg.wasm'a gitmeden önce `OfflineAudioContext`
  içinde üretiliyor. Uygulama engellemek yerine bu noktada uyarıyor.

## Diller

Arayüz Türkçe ve İngilizce. Dil, tarayıcı diline göre seçilir, üst çubuktan
değiştirilebilir ve tercih `localStorage`'da saklanır.

Metinlerin tamamı [`src/i18n/messages.ts`](src/i18n/messages.ts) içinde. Bir
dilde eksik anahtar bırakmak derleme hatası verir, yani çeviri unutulamaz. Skor
motoru geri bildirimi metin değil kod döndürür (`{ code: 'late', ms: 320 }`);
çeviriyi arayüz yapar, böylece DSP katmanı dilden habersiz kalır.

## Deploy

Statik çıktı; `dist/` klasörünü olduğu gibi yayınla (Vercel, Cloudflare Pages,
Netlify, GitHub Pages…). SharedArrayBuffer kullanılmadığı için COOP/COEP
başlığı gerekmiyor.

```bash
npm run build
```

## Lisans

MIT — bkz. [LICENSE](LICENSE).
