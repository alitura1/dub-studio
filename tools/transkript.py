"""
Paket üretirken çalışan transkripsiyon adımı.

Tarayıcıdaki whisper-base yerine burada faster-whisper kullanılıyor. Sebep
ölçüldü: müziği baskın bir klipte tarayıcı modeli 26 saniyeye "I'm sorry."
diyordu; aynı klipte faster-whisper altı repliği de doğru çıkardı.

Kelime düzeyinde zaman damgası döndürüyoruz — replik sınırları buradan
kuruluyor. Enerji tabanlı bölme aynı klipte 4-6 saniyelik bloklar üretmişti,
çünkü müzik gürültü tabanını yukarı çekiyor.

Çıktı tek satır JSON, stdout'a. Hatalar stderr'e; çağıran taraf transkripsiyonu
atlayıp devam edebilsin diye burada asla çökmüyoruz.

Kullanım:
    python tools/transkript.py <wav> [--model small] [--dil en]
"""

import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--model", default="small")
    parser.add_argument("--dil", default=None)
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({"error": "faster-whisper kurulu değil"}), flush=True)
        return 0

    try:
        # int8 CPU'da belirgin hızlı ve bu boyutlarda doğruluk farkı görülmedi.
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
        segments, info = model.transcribe(
            args.audio,
            language=args.dil,
            word_timestamps=True,
            # vad_filter bilerek kapalı: açıkken replik başlarını kırpıyor,
            # ölçümde "I'm Jewish." -> "Jewish." oldu. Sessizliği zaten
            # kelime damgalarından anlıyoruz.
            vad_filter=False,
        )

        words = []
        for segment in segments:
            for word in segment.words or []:
                text = word.word.strip()
                if not text:
                    continue
                words.append(
                    {
                        "startMs": round(word.start * 1000),
                        "endMs": round(word.end * 1000),
                        "text": text,
                    }
                )

        print(
            json.dumps(
                {"language": info.language, "words": words},
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception as exc:  # noqa: BLE001 - araç durmamalı
        print(json.dumps({"error": str(exc)}), flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
