/**
 * Sakoe-Chiba bantlı Dynamic Time Warping.
 *
 * Kullanıcı repliği referanstan hızlı veya yavaş okuyabilir; enerji ve perde
 * konturlarını karşılaştırmadan önce onları hizalamamız gerekiyor. Bant,
 * saçma hizalamaları (tüm repliği tek çerçeveye sıkıştırmak gibi) engelliyor.
 */

export interface DtwResult {
  /** [refIndex, userIndex] çiftleri, baştan sona. */
  path: Int32Array
  pathLength: number
  /** Yol uzunluğuna bölünmüş toplam maliyet. */
  normalizedCost: number
}

export type CostFn = (i: number, j: number) => number

const INF = Number.POSITIVE_INFINITY

export function dtw(n: number, m: number, cost: CostFn, bandRatio = 0.25): DtwResult {
  if (n === 0 || m === 0) {
    return { path: new Int32Array(0), pathLength: 0, normalizedCost: INF }
  }
  const radius = Math.max(1, Math.ceil(Math.max(n, m) * bandRatio))
  // Köşegen (0,0) -> (n-1, m-1) olmalı; m/n eğimi son çerçeveyi bandın dışında
  // bırakıp uzunlukları farklı dizilerde DTW'yi çözümsüz kılıyordu.
  const slope = n > 1 ? (m - 1) / (n - 1) : 0
  const acc = new Float64Array(n * m).fill(INF)

  const inBand = (i: number, j: number) =>
    n === 1 || m === 1 ? true : Math.abs(j - i * slope) <= radius

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (!inBand(i, j)) continue
      const c = cost(i, j)
      if (i === 0 && j === 0) {
        acc[0] = c
        continue
      }
      let best = INF
      if (i > 0 && acc[(i - 1) * m + j] < best) best = acc[(i - 1) * m + j]
      if (j > 0 && acc[i * m + (j - 1)] < best) best = acc[i * m + (j - 1)]
      if (i > 0 && j > 0 && acc[(i - 1) * m + (j - 1)] < best) best = acc[(i - 1) * m + (j - 1)]
      acc[i * m + j] = best === INF ? INF : best + c
    }
  }

  const total = acc[(n - 1) * m + (m - 1)]
  if (!isFinite(total)) {
    return { path: new Int32Array(0), pathLength: 0, normalizedCost: INF }
  }

  // Geri izleme
  const path: number[] = []
  let i = n - 1
  let j = m - 1
  while (i > 0 || j > 0) {
    path.push(i, j)
    const diag = i > 0 && j > 0 ? acc[(i - 1) * m + (j - 1)] : INF
    const up = i > 0 ? acc[(i - 1) * m + j] : INF
    const left = j > 0 ? acc[i * m + (j - 1)] : INF
    if (diag <= up && diag <= left) {
      i--
      j--
    } else if (up <= left) {
      i--
    } else {
      j--
    }
  }
  path.push(0, 0)
  path.reverse()
  // reverse() çiftleri de ters çevirdi; [i,j] sırasını geri al
  for (let k = 0; k < path.length; k += 2) {
    const a = path[k]
    path[k] = path[k + 1]
    path[k + 1] = a
  }

  const pathLength = path.length / 2
  return { path: Int32Array.from(path), pathLength, normalizedCost: total / pathLength }
}

/**
 * DTW yolunun köşegenden ortalama sapması, referans çerçeve cinsinden.
 * 0 = birebir aynı tempo; büyüdükçe kullanıcı hızlanıp yavaşlamış demektir.
 */
export function pathDeviation(result: DtwResult, n: number, m: number): number {
  if (result.pathLength === 0) return INF
  const slope = n > 1 ? (m - 1) / (n - 1) : 0
  let sum = 0
  for (let k = 0; k < result.pathLength; k++) {
    const i = result.path[k * 2]
    const j = result.path[k * 2 + 1]
    sum += Math.abs(j - i * slope)
  }
  return sum / result.pathLength
}
