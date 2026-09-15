// Fountain symbol selection: dense random rows up to DENSE_MAX_K, LT above. Everything here is wire behavior: sender and
// receiver must derive identical block sets from (transferId, symbolId, k)
// forever, on every JS engine. Math.log and Math.sqrt are not guaranteed
// bit-identical across engines, so ln and sqrt are built from + - * / only.
import { DATA_BYTES, DENSE_MAX_K } from "../protocol.ts";

const C = 0.1;
const DELTA = 0.5;
const LN2 = 0.6931471805599453;

export function blockCount(byteLength: number): number {
  return Math.max(1, Math.ceil(byteLength / DATA_BYTES));
}

export function blockSet(
  transferId: number,
  symbolId: number,
  k: number,
): number[] {
  if (symbolId < k) return [symbolId];

  const random = mulberry32(Math.imul(transferId + 1, 0x9e3779b1) ^ symbolId);
  if (k <= DENSE_MAX_K) {
    const blocks: number[] = [];
    for (let b = 0; b < k; b++) if (random() < 0.5) blocks.push(b);
    return blocks.length ? blocks : [Math.floor(random() * k)];
  }
  const degree = sampleDegree(k, random());
  const blocks = new Set<number>();
  while (blocks.size < degree) blocks.add(Math.floor(random() * k));
  return [...blocks].sort((a, b) => a - b);
}

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let cached: { k: number; cdf: Float64Array } | undefined;

function sampleDegree(k: number, u: number): number {
  if (cached?.k !== k) cached = { k, cdf: robustSolitonCdf(k) };
  const { cdf } = cached;
  let lo = 0;
  let hi = k - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] > u) hi = mid;
    else lo = mid + 1;
  }
  return lo + 1;
}

function robustSolitonCdf(k: number): Float64Array {
  const r = C * ln(k / DELTA) * sqrt(k);
  const spike = Math.min(k, Math.max(1, Math.floor(k / r)));
  const cdf = new Float64Array(k);
  let total = 0;
  for (let d = 1; d <= k; d++) {
    const rho = d === 1 ? 1 / k : 1 / (d * (d - 1));
    let tau = 0;
    if (d < spike) tau = r / (d * k);
    else if (d === spike) tau = Math.max(0, (r * ln(r / DELTA)) / k);
    total += rho + tau;
    cdf[d - 1] = total;
  }
  for (let i = 0; i < k; i++) cdf[i] /= total;
  return cdf;
}

function ln(x: number): number {
  let exponent = 0;
  while (x > 2) {
    x /= 2;
    exponent++;
  }
  while (x < 1) {
    x *= 2;
    exponent--;
  }
  const y = (x - 1) / (x + 1);
  const y2 = y * y;
  let sum = 0;
  let term = y;
  for (let n = 1; n < 64; n += 2) {
    sum += term / n;
    term *= y2;
  }
  return 2 * sum + exponent * LN2;
}

function sqrt(x: number): number {
  let s = x;
  for (let i = 0; i < 64; i++) s = (s + x / s) / 2;
  return s;
}
