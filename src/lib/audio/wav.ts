/**
 * WAV okuma/yazma. CLI tarafında ffmpeg'in ürettiği pcm_s16le dosyalarını
 * okumak, tarayıcı tarafında export miksini yazmak için kullanılıyor.
 * Aynı modül olması, iki taraftaki analiz zincirinin aynı örneklere
 * bakmasını garantiliyor.
 */

export interface DecodedWav {
  sampleRate: number
  channels: Float32Array[]
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = ''
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i))
  return s
}

export function decodeWav(bytes: Uint8Array): DecodedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Geçerli bir WAV dosyası değil')
  }

  let offset = 12
  let format = 1
  let numChannels = 1
  let sampleRate = 44100
  let bitsPerSample = 16
  let dataOffset = -1
  let dataLength = 0

  while (offset + 8 <= bytes.byteLength) {
    const id = readAscii(view, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      numChannels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
      if (format === 0xfffe && size >= 40) {
        // WAVE_FORMAT_EXTENSIBLE: gerçek format GUID'in ilk 2 baytında
        format = view.getUint16(body + 24, true)
      }
    } else if (id === 'data') {
      dataOffset = body
      dataLength = Math.min(size, bytes.byteLength - body)
    }
    offset = body + size + (size % 2)
  }

  if (dataOffset < 0) throw new Error('WAV içinde data chunk bulunamadı')

  const bytesPerSample = bitsPerSample >> 3
  const frames = Math.floor(dataLength / (bytesPerSample * numChannels))
  const channels = Array.from({ length: numChannels }, () => new Float32Array(frames))

  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < numChannels; c++) {
      const p = dataOffset + (f * numChannels + c) * bytesPerSample
      let v = 0
      if (format === 3 && bitsPerSample === 32) v = view.getFloat32(p, true)
      else if (bitsPerSample === 16) v = view.getInt16(p, true) / 32768
      else if (bitsPerSample === 32) v = view.getInt32(p, true) / 2147483648
      else if (bitsPerSample === 24) {
        const b0 = view.getUint8(p)
        const b1 = view.getUint8(p + 1)
        const b2 = view.getInt8(p + 2)
        v = ((b2 << 16) | (b1 << 8) | b0) / 8388608
      } else if (bitsPerSample === 8) v = (view.getUint8(p) - 128) / 128
      channels[c][f] = v
    }
  }

  return { sampleRate, channels }
}

/** Float32 kanalları 16-bit PCM WAV'a yazar (kırpma dahil). */
export function encodeWavPcm16(channels: Float32Array[], sampleRate: number): Uint8Array {
  const numChannels = Math.max(1, channels.length)
  const frames = channels.length > 0 ? channels[0].length : 0
  const dataSize = frames * numChannels * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numChannels * 2, true)
  view.setUint16(32, numChannels * 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataSize, true)

  let p = 44
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][f]))
      view.setInt16(p, s < 0 ? s * 32768 : s * 32767, true)
      p += 2
    }
  }
  return new Uint8Array(buffer)
}
