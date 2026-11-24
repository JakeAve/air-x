// Systematic Raptor-style code for k > DENSE_MAX_K, after RFC 6330 but binary
// and with its own parameters. L intermediate blocks satisfy S sparse (LDPC)
// and H dense (HDPC) parity constraints, and every symbol, source or repair, is
// an LT row over them; the encoder solves for intermediates whose rows 0..K-1
// are the source blocks. Rows are padded to K' (zero blocks neither side
// sends), where SEEDS holds a seed that makes the square system invertible.
// Everything here is wire behavior: integer arithmetic only.
import { SEEDS } from "./seeds.ts";

export const PAD_START = 129;

/** The padded sizes: 129, then each next = prev + ceil(prev / 32). */
export function padIndex(k: number): number {
  let kPad = PAD_START;
  let i = 0;
  while (kPad < k) {
    kPad += Math.ceil(kPad / 32);
    i++;
  }
  return i;
}

export function padSize(index: number): number {
  let kPad = PAD_START;
  for (let i = 0; i < index; i++) kPad += Math.ceil(kPad / 32);
  return kPad;
}

export interface Code {
  k: number;
  kPad: number;
  seed: number;
  /** LDPC rows. */
  s: number;
  /** HDPC rows. */
  h: number;
  /** LT columns, prime. */
  w: number;
  /** Permanently inactive columns, W..L-1; the last H are the HDPC columns. */
  p: number;
  p1: number;
  /** Intermediate blocks. */
  l: number;
}

export function makeCode(k: number, seed?: number, kPad?: number): Code {
  const index = padIndex(k);
  kPad ??= padSize(index);
  if (seed === undefined) {
    seed = SEEDS[index];
    if (seed === undefined) throw new RangeError(`k ${k} has no seed`);
  }
  let x = 1;
  while (x * (x - 1) < 2 * kPad) x++;
  const s = nextPrime(Math.ceil(kPad / 100) + x);
  let h = 1;
  while (binomial(h, Math.ceil(h / 2)) < kPad + s) h++;
  const l = kPad + s + h;
  const w = prevPrime(l - h - isqrt(kPad));
  const p = l - w;
  return { k, kPad, seed, s, h, w, p, p1: nextPrime(p), l };
}

// Degree CDF out of 2^20: 1 with probability 0.5%, then ideal soliton up to
// 29, the rest at 30. Same shape as RFC 6330's table.
const DEGREE_CDF = (() => {
  const cdf = [0, 5243];
  for (let d = 2; d < 30; d++) {
    cdf.push(5243 + Math.floor(((d - 1) * 1048576 + d - 1) / d));
  }
  cdf.push(1048576);
  return cdf;
})();

/** The intermediate columns symbol `isi` XORs. */
export function ltRow(code: Code, isi: number): Int32Array {
  const { w, p, p1, seed } = code;
  const r = (salt: number) => hash(seed, isi, salt);
  const v = r(0) & 0xfffff;
  let d = 1;
  while (v >= DEGREE_CDF[d]) d++;
  const a = 1 + (r(1) % (w - 1));
  let b = r(2) % w;
  const d1 = d < 4 ? 2 + (r(3) % 2) : 2;
  const a1 = 1 + (r(4) % (p1 - 1));
  let b1 = r(5) % p1;
  const row = new Int32Array(d + d1);
  row[0] = b;
  for (let j = 1; j < d; j++) row[j] = b = (b + a) % w;
  while (b1 >= p) b1 = (b1 + a1) % p1;
  row[d] = w + b1;
  for (let j = 1; j < d1; j++) {
    b1 = (b1 + a1) % p1;
    while (b1 >= p) b1 = (b1 + a1) % p1;
    row[d + j] = w + b1;
  }
  return row;
}

/** S rows: each of the first W - S columns in three, an identity on the S LDPC columns, two inactive columns. */
export function ldpcRows(code: Code): Int32Array[] {
  const { s, w, p } = code;
  const bCols = w - s;
  const cols: number[][] = Array.from({ length: s }, (_, i) => [
    bCols + i,
    w + (i % p),
    w + ((i + 1) % p),
  ]);
  for (let i = 0; i < bCols; i++) {
    const a = 1 + (Math.floor(i / s) % (s - 1));
    let b = i % s;
    cols[b].push(i);
    b = (b + a) % s;
    cols[b].push(i);
    b = (b + a) % s;
    cols[b].push(i);
  }
  return cols.map((c) => Int32Array.from(c));
}

/** H dense rows as bitsets over L: each non-HDPC column with probability 1/2, plus an identity on the HDPC columns. */
export function hdpcRows(code: Code): Uint32Array[] {
  const { h, l, seed } = code;
  const words = (l + 31) >>> 5;
  const dense = l - h;
  const rows: Uint32Array[] = [];
  for (let i = 0; i < h; i++) {
    const row = new Uint32Array(words);
    for (let word = 0; word < words; word++) {
      row[word] = hash(seed, 0x40000000 + i, word);
    }
    // Clear the HDPC columns and the tail, then set this row's own.
    for (let c = dense; c < words * 32; c++) {
      row[c >>> 5] &= ~(1 << (c & 31));
    }
    const own = dense + i;
    row[own >>> 5] |= 1 << (own & 31);
    rows.push(row);
  }
  return rows;
}

function hash(a: number, b: number, c: number): number {
  let x = Math.imul(a ^ 0x2545f491, 0x9e3779b1);
  x = Math.imul(x ^ (x >>> 15) ^ b, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13) ^ Math.imul(c + 1, 0xc2b2ae35), 0x27d4eb2f);
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  return (x ^ (x >>> 15)) >>> 0;
}

function isPrime(n: number): boolean {
  if (n < 2) return false;
  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
  return true;
}

function nextPrime(n: number): number {
  while (!isPrime(n)) n++;
  return n;
}

function prevPrime(n: number): number {
  while (!isPrime(n)) n--;
  return n;
}

function isqrt(n: number): number {
  let r = 0;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

function binomial(n: number, k: number): number {
  let out = 1;
  for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i;
  return out;
}

export interface SolveData {
  /** `stride` words per block. */
  blocks: Uint32Array;
  /** Per row, its block in `blocks`, or -1 for a zero block. */
  index: Int32Array;
  stride: number;
}

/**
 * Solves the intermediate blocks from sparse rows (LT and LDPC) and the HDPC
 * rows by inactivation decoding: peel, inactivating a column whenever peeling
 * stalls, then Gauss-Jordan on the inactive columns alone, then back
 * substitution. A system short of rank keeps its state, so each row `add`ed
 * later costs one dense row instead of a fresh solve. With no data it only
 * tracks rank.
 */
export class Solver {
  readonly #rows: Int32Array[];
  readonly #data?: SolveData;
  readonly #stride: number;
  readonly #state: Uint8Array;
  readonly #where: Int32Array;
  readonly #inactive: number[] = [];
  readonly #pivotCols: number[] = [];
  readonly #pivotRows: number[] = [];
  readonly #words: number;
  /** Per pivoted column: M_c, its row over the inactive columns. */
  readonly #m: Uint32Array;
  /** Per pivoted column: its block, less M_c times the inactive blocks. */
  readonly #a: Uint32Array;
  /** Gauss-Jordan rows over the inactive columns, by pivot column. */
  readonly #denseBits: (Uint32Array | undefined)[];
  readonly #denseRhs: (Uint32Array | undefined)[];
  readonly #mask: Uint32Array;
  #rank = 0;

  constructor(
    code: Code,
    rows: Int32Array[],
    hdpc: Uint32Array[],
    data?: SolveData,
  ) {
    const { l, w } = code;
    const n = rows.length;
    this.#rows = rows;
    this.#data = data;
    const stride = this.#stride = data?.stride ?? 0;

    // Column -> rows, CSR.
    const start = new Int32Array(l + 1);
    for (const row of rows) for (const c of row) start[c + 1]++;
    for (let c = 0; c < l; c++) start[c + 1] += start[c];
    const fill = start.slice(0, l);
    const colRows = new Int32Array(start[l]);
    rows.forEach((row, r) => {
      for (const c of row) colRows[fill[c]++] = r;
    });

    // 0 active, 1 pivoted, 2 inactive.
    const state = this.#state = new Uint8Array(l);
    const inactive = this.#inactive;
    for (let c = w; c < l; c++) {
      state[c] = 2;
      inactive.push(c);
    }
    const count = new Int32Array(n);
    const used = new Uint8Array(n);
    const ones: number[] = [];
    const buckets: number[][] = [];
    let minBucket = Infinity;
    const enqueue = (r: number) => {
      const k = count[r];
      if (k === 1) ones.push(r);
      else if (k > 1) {
        (buckets[k] ??= []).push(r);
        if (k < minBucket) minBucket = k;
      }
    };
    for (let r = 0; r < n; r++) {
      for (const c of rows[r]) if (state[c] === 0) count[r]++;
      enqueue(r);
    }
    const drop = (c: number) => {
      for (let i = start[c]; i < start[c + 1]; i++) {
        const r = colRows[i];
        if (used[r]) continue;
        count[r]--;
        enqueue(r);
      }
    };

    const pivotCols = this.#pivotCols;
    const pivotRows = this.#pivotRows;
    for (;;) {
      let r = -1;
      while (ones.length) {
        const q = ones.pop()!;
        if (!used[q] && count[q] === 1) {
          r = q;
          break;
        }
      }
      if (r < 0) {
        for (; minBucket < buckets.length; minBucket++) {
          const bucket = buckets[minBucket];
          while (bucket?.length) {
            const q = bucket.pop()!;
            if (!used[q] && count[q] === minBucket) {
              r = q;
              break;
            }
          }
          if (r >= 0) break;
        }
        if (r < 0) break;
        // Keep the active column in the fewest rows, inactivate the rest.
        let keep = -1;
        for (const c of rows[r]) {
          if (
            state[c] === 0 &&
            (keep < 0 ||
              start[c + 1] - start[c] < start[keep + 1] - start[keep])
          ) keep = c;
        }
        for (const c of rows[r]) {
          if (state[c] !== 0 || c === keep) continue;
          state[c] = 2;
          inactive.push(c);
          drop(c);
        }
      }
      let col = -1;
      for (const c of rows[r]) if (state[c] === 0) col = c;
      state[col] = 1;
      used[r] = 1;
      pivotCols.push(col);
      pivotRows.push(r);
      drop(col);
    }
    for (let c = 0; c < w; c++) {
      if (state[c] === 0) {
        state[c] = 2;
        inactive.push(c);
      }
    }

    // Each pivoted column as a_c + M_c . (inactive blocks), in pivot order.
    const ni = inactive.length;
    const words = this.#words = (ni + 31) >>> 5;
    const where = this.#where = new Int32Array(l).fill(-1);
    inactive.forEach((c, i) => (where[c] = i));
    const m = this.#m = new Uint32Array(l * words);
    const a = this.#a = new Uint32Array(l * stride);
    const blocks = data?.blocks ?? a;
    const index = data?.index;
    for (let j = 0; j < pivotCols.length; j++) {
      const c = pivotCols[j];
      const r = pivotRows[j];
      const row = rows[r];
      const mc = c * words;
      const ac = c * stride;
      const src = index ? index[r] * stride : -1;
      if (src >= 0) {
        for (let t = 0; t < stride; t++) a[ac + t] = blocks[src + t];
      }
      for (let e = 0; e < row.length; e++) {
        const c2 = row[e];
        if (c2 === c) continue;
        if (state[c2] === 2) {
          const i = where[c2];
          m[mc + (i >>> 5)] ^= 1 << (i & 31);
        } else {
          const m2 = c2 * words;
          for (let t = 0; t < words; t++) m[mc + t] ^= m[m2 + t];
          const a2 = c2 * stride;
          for (let t = 0; t < stride; t++) a[ac + t] ^= a[a2 + t];
        }
      }
    }

    this.#denseBits = new Array(ni);
    this.#denseRhs = new Array(ni);
    this.#mask = new Uint32Array(words);
    for (let r = 0; r < n; r++) {
      if (used[r]) continue;
      const src = index ? index[r] : -1;
      this.#addDense(
        rows[r],
        src >= 0
          ? blocks.subarray(src * stride, (src + 1) * stride)
          : undefined,
      );
    }
    for (const row of hdpc) {
      const bits = new Uint32Array(words);
      const rhs = new Uint32Array(stride);
      for (let word = 0; word < row.length; word++) {
        for (let v = row[word]; v; v &= v - 1) {
          this.#addColumn(bits, rhs, (word << 5) + (31 - Math.clz32(v & -v)));
        }
      }
      this.#insert(bits, rhs);
    }
  }

  /** Inactive columns no row pins down yet. */
  get deficiency(): number {
    return this.#inactive.length - this.#rank;
  }

  /** Another row over the intermediates, with its block (zero if omitted). */
  add(row: Int32Array, block?: Uint32Array): void {
    if (this.deficiency) this.#addDense(row, block);
  }

  /** The intermediate blocks, once the system has full rank. */
  intermediates(): Uint32Array | undefined {
    if (this.deficiency || !this.#data) return undefined;
    const stride = this.#stride;
    const a = this.#a;
    const { blocks, index } = this.#data;
    this.#inactive.forEach((c, i) => a.set(this.#denseRhs[i]!, c * stride));
    const rows = this.#rows;
    for (let j = 0; j < this.#pivotCols.length; j++) {
      const c = this.#pivotCols[j];
      const r = this.#pivotRows[j];
      const row = rows[r];
      const ac = c * stride;
      const src = index[r] * stride;
      for (let t = 0; t < stride; t++) {
        a[ac + t] = src >= 0 ? blocks[src + t] : 0;
      }
      for (let e = 0; e < row.length; e++) {
        const a2 = row[e] * stride;
        if (a2 !== ac) {
          for (let t = 0; t < stride; t++) a[ac + t] ^= a[a2 + t];
        }
      }
    }
    return a;
  }

  #addDense(row: Int32Array, block: Uint32Array | undefined): void {
    const bits = new Uint32Array(this.#words);
    const rhs = new Uint32Array(this.#stride);
    if (block && this.#stride) rhs.set(block);
    for (let e = 0; e < row.length; e++) this.#addColumn(bits, rhs, row[e]);
    this.#insert(bits, rhs);
  }

  #addColumn(bits: Uint32Array, rhs: Uint32Array, c: number): void {
    const words = this.#words;
    if (this.#state[c] === 2) {
      const i = this.#where[c];
      bits[i >>> 5] ^= 1 << (i & 31);
      return;
    }
    const m = this.#m;
    const mc = c * words;
    for (let t = 0; t < words; t++) bits[t] ^= m[mc + t];
    const a = this.#a;
    const ac = c * this.#stride;
    for (let t = 0; t < rhs.length; t++) rhs[t] ^= a[ac + t];
  }

  // Keeps the dense rows in Gauss-Jordan form: each pivot row is zero in every
  // other pivot column, so a new row reduces in one pass.
  #insert(bits: Uint32Array, rhs: Uint32Array): void {
    const words = this.#words;
    const mask = this.#mask;
    for (let t = 0; t < words; t++) {
      for (let v = bits[t] & mask[t]; v; v &= v - 1) {
        const col = (t << 5) + (31 - Math.clz32(v & -v));
        xorInto(bits, this.#denseBits[col]!);
        xorInto(rhs, this.#denseRhs[col]!);
      }
    }
    let col = -1;
    for (let t = 0; t < words && col < 0; t++) {
      if (bits[t]) col = (t << 5) + (31 - Math.clz32(bits[t] & -bits[t]));
    }
    if (col < 0) return;
    const word = col >>> 5;
    const bit = 1 << (col & 31);
    for (let i = 0; i < this.#denseBits.length; i++) {
      const other = this.#denseBits[i];
      if (other && other[word] & bit) {
        xorInto(other, bits);
        xorInto(this.#denseRhs[i]!, rhs);
      }
    }
    this.#denseBits[col] = bits;
    this.#denseRhs[col] = rhs;
    mask[word] |= bit;
    this.#rank++;
  }
}

function xorInto(dst: Uint32Array, src: Uint32Array): void {
  for (let t = 0; t < dst.length; t++) dst[t] ^= src[t];
}

/** The square source system of a padded size, for picking seeds. */
export function invertible(kPad: number, seed: number): boolean {
  const code = makeCode(kPad, seed, kPad);
  const rows = ldpcRows(code);
  for (let i = 0; i < kPad; i++) rows.push(ltRow(code, i));
  return new Solver(code, rows, hdpcRows(code)).deficiency === 0;
}

/** Blocks as 32-bit words, `stride` per block, so XORs run a word at a time. */
export function wordStride(dataBytes: number): number {
  return (dataBytes + 3) >>> 2;
}

/** XORs the intermediate blocks of `isi`'s row into `out`. */
export function symbolData(
  code: Code,
  intermediates: Uint32Array,
  stride: number,
  isi: number,
  out: Uint8Array,
): void {
  const word = new Uint32Array(stride);
  for (const c of ltRow(code, isi)) {
    for (let j = 0; j < stride; j++) word[j] ^= intermediates[c * stride + j];
  }
  out.set(new Uint8Array(word.buffer, 0, out.length));
}

/** A solver over the LDPC and HDPC rows plus the LT rows of `isis`. */
export function symbolSolver(
  code: Code,
  isis: ArrayLike<number>,
  data: SolveData,
): Solver {
  const rows = ldpcRows(code);
  const s = rows.length;
  const index = new Int32Array(s + isis.length).fill(-1);
  for (let i = 0; i < isis.length; i++) {
    rows.push(ltRow(code, isis[i]));
    index[s + i] = data.index[i];
  }
  return new Solver(code, rows, hdpcRows(code), { ...data, index });
}
