/**
 * Biquad filtreler (RBJ cookbook).
 *
 * Perde takibinden önce bandı daraltmak için var. Gerçek dizi/film kliplerinde
 * arka plan müziğinin bas enerjisi ve tizdeki efektler YIN'in otokorelasyonunu
 * bozuyordu: Homelander klibinde sesli çerçeve oranı %3'ün altındaydı, yani
 * skorun perde ekseni pratikte hiç çalışmıyordu.
 *
 * Faz bozulması önemli değil — periyot arıyoruz, dalga şeklini değil.
 */

interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

function lowpass(freq: number, sampleRate: number, q = Math.SQRT1_2): Biquad {
  const w0 = (2 * Math.PI * freq) / sampleRate
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  const a0 = 1 + alpha
  return {
    b0: ((1 - cos) / 2) / a0,
    b1: (1 - cos) / a0,
    b2: ((1 - cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  }
}

function highpass(freq: number, sampleRate: number, q = Math.SQRT1_2): Biquad {
  const w0 = (2 * Math.PI * freq) / sampleRate
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  const a0 = 1 + alpha
  return {
    b0: ((1 + cos) / 2) / a0,
    b1: (-(1 + cos)) / a0,
    b2: ((1 + cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  }
}

function apply(x: Float32Array, f: Biquad, out: Float32Array): Float32Array {
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < x.length; i++) {
    const xn = x[i]
    const yn = f.b0 * xn + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2
    x2 = x1
    x1 = xn
    y2 = y1
    y1 = yn
    out[i] = yn
  }
  return out
}

/**
 * İki kademeli bant geçiren. Konuşmanın temel frekansı ve ilk birkaç
 * harmoniği 70-1100 Hz arasında; dışarısı perde için gürültü.
 */
export function bandpass(x: Float32Array, sampleRate: number, lowHz = 70, highHz = 1100): Float32Array {
  const nyquist = sampleRate / 2
  const out = new Float32Array(x.length)
  let signal = apply(x, highpass(Math.min(lowHz, nyquist * 0.9), sampleRate), out)
  if (highHz < nyquist * 0.95) {
    signal = apply(signal, lowpass(highHz, sampleRate), new Float32Array(x.length))
  }
  return signal
}
