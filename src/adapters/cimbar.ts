// libcimbar (static/cimbar, MPL-2.0, v0.6.9 release, unmodified): color icon
// matrix barcodes, about 7.5 KB a frame in mode B, the only mode used. It runs
// its own fountain code (wirehair) and zstd, so the bundle goes in as one file
// and comes out whole; our packets are not involved. A frame's header carries
// the sender's 7-bit encode id, which is the transfer id, so acks and DONE
// work as for any camera codec. Its acks name no blocks: wirehair needs only
// enough of any of them.
import { aborted } from "@/lib/abort.ts";
import { type CameraEncoder, OVERHEAD } from "@/lib/cameraCodec.ts";
import { cimbarHeader } from "@/lib/cimbarFrame.ts";
import { nv12ToRgba } from "@/lib/nv12.ts";
import type { CameraRate } from "@/lib/rate.ts";
import type {
  PacketStats,
  TransferDecoder,
  TransferHeard,
} from "@/lib/transferDecoder.ts";

const BUILD = "cimbar/cimbar_js.2026-11-18T0531";
const WORKER = "cimbar/recv-worker.2026-11-18T0531.js";
/** Mode B: square, 4 colors, the densest that read on an iPhone. */
const MODE_B = 68;
/** What a mode B frame carries, measured; estimates and the send line count it. */
export const CIMBAR_FRAME_BYTES = 7500;
/** Longer edge of what the decoders get: cimbar's corner finder misses codes in 4K frames that it finds at half size. */
const DECODE_EDGE = 1920;

interface Wasm {
  HEAPU8: Uint8Array;
  _malloc(n: number): number;
  _free(p: number): void;
  _cimbare_init_window(w: number, h: number): number;
  _cimbare_configure(mode: number, compression: number): number;
  _cimbare_get_aspect_ratio(): number;
  _cimbare_rotate_window(rotate: boolean): number;
  _cimbare_init_encode(name: number, length: number, id: number): number;
  _cimbare_encode_bufsize(): number;
  _cimbare_encode(p: number, n: number): number;
  _cimbare_render(): number;
  _cimbare_next_frame(colorBalance: boolean): number;
  _cimbard_configure_decode(mode: number): number;
  _cimbard_get_bufsize(): number;
  _cimbard_fountain_decode(p: number, n: number): number | bigint;
  _cimbard_get_report(p: number, n: number): number;
  _cimbard_get_decompress_bufsize(): number;
  _cimbard_decompress_read(id: number, p: number, n: number): number;
}

let loading: Promise<Wasm> | undefined;
let windowReady = false;

/** One instance per page, encoder and decoder both. Emscripten's GLFW binds `canvas` at load. */
function load(canvas: HTMLCanvasElement): Promise<Wasm> {
  loading ??= new Promise((resolve, reject) => {
    const g = globalThis as unknown as { Module: Record<string, unknown> };
    g.Module = {
      canvas,
      onRuntimeInitialized: () => resolve(g.Module as unknown as Wasm),
    };
    const script = document.createElement("script");
    script.src = `${BUILD}.js`;
    script.onerror = () => {
      loading = undefined;
      reject(new Error("cimbar failed to load"));
    };
    document.head.append(script);
  });
  return loading;
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/** Expected seconds to send a bundle of this size by cimbar at this rate. */
export const cimbarSeconds = (bundleBytes: number, rate: CameraRate): number =>
  Math.ceil(OVERHEAD * bundleBytes / CIMBAR_FRAME_BYTES) / rate.fps;

/** Animated cimbar codes on `canvas`, one frame per `1 / fps`, until the signal aborts. */
export function cimbarEncoder(canvas: HTMLCanvasElement): CameraEncoder {
  return {
    name: "cimbar",
    idBits: 7,
    start(bundle, transferId, rate, signal, onFrame) {
      let frames = 0;
      const run = async () => {
        const m = await load(canvas);
        if (signal.aborted) return;
        if (!windowReady) {
          m._cimbare_init_window(0, 0);
          windowReady = true;
        }
        m._cimbare_configure(MODE_B, -1);
        const ratio = m._cimbare_get_aspect_ratio();
        const rotate = ratio > 1 && innerHeight > innerWidth;
        m._cimbare_rotate_window(rotate);
        const fit = () => fitCanvas(canvas, rotate ? 1 / ratio : ratio);
        fit();
        addEventListener("resize", fit);
        try {
          encode(m, bundle, transferId);
          // Draw only when the code advances: each render shifts the code
          // slightly (cimbar's shakycam), so redrawing a held code shakes it.
          m._cimbare_next_frame(false); // frame 0, before the first render
          let last = -Infinity;
          while (!signal.aborted) {
            const now = await nextFrame();
            if (now - last < 1000 / rate.fps) continue;
            last = now;
            m._cimbare_render();
            m._cimbare_next_frame(false);
            frames++;
            onFrame?.({
              frames,
              fresh: frames,
              freshBytes: frames * CIMBAR_FRAME_BYTES,
              rate,
            });
          }
        } finally {
          removeEventListener("resize", fit);
        }
      };
      return {
        setRate: (next) => rate = next,
        resend: () => 0, // wirehair needs no particular block back
        get fresh() {
          return frames;
        },
        done: run(),
      };
    },
    seconds: cimbarSeconds,
  };
}

function encode(m: Wasm, bundle: Uint8Array, transferId: number) {
  const name = new TextEncoder().encode("air-x.bundle");
  const chunk = m._cimbare_encode_bufsize() * 16;
  const buf = m._malloc(Math.max(chunk, name.length));
  try {
    m.HEAPU8.set(name, buf);
    if (m._cimbare_init_encode(buf, name.length, transferId) < 0) {
      throw new Error("cimbar could not start encoding");
    }
    for (let at = 0; at < bundle.length; at += chunk) {
      const part = bundle.subarray(at, at + chunk);
      m.HEAPU8.set(part, buf); // HEAPU8 is re-read: wasm memory may have grown
      m._cimbare_encode(buf, part.length);
    }
    m._cimbare_encode(buf, 0); // flush
  } finally {
    m._free(buf);
  }
}

/**
 * Sizes `canvas` in whole CSS px at `aspect` (width over height), as large as
 * its parent's content box allows; give it a parent the size of the window,
 * since a code drawn under its native 1040 px blurs its tiles together. The GL
 * output is laid out to the element's box, so a box off the code's aspect
 * stretches the code; CSS alone (aspect-ratio, object-fit) lost to the page's
 * layout on a desktop window.
 */
function fitCanvas(canvas: HTMLCanvasElement, aspect: number) {
  // Collapsed first: at its natural size (the 1040 px buffer) it would widen the box it is measured against.
  canvas.style.width = canvas.style.height = "0";
  const box = canvas.parentElement!;
  const width = Math.floor(
    Math.min(box.clientWidth, (box.clientHeight || innerHeight) * aspect),
  );
  canvas.style.width = `${width}px`;
  canvas.style.height = `${Math.floor(width / aspect)}px`;
}

/** Frames seen by a cimbar decoder, besides the `PacketStats` every camera decoder keeps. */
export interface CimbarStats extends PacketStats {
  /** Frames handed to the decoders. */
  frames: number;
  /** Frames with no code found, and with a code found but unreadable. */
  noCode: number;
  unreadable: number;
  /** Frames that failed for any other reason, with the last one's message. */
  errors: number;
  lastError?: string;
}

type WorkerReply = {
  type?: string;
  buff?: Uint8Array;
  nodata?: boolean;
  failed_extract?: boolean;
  error?: unknown;
  res?: string;
};

interface Tally {
  /** The highest first-block id of a frame read. */
  highest: number;
  /** Distinct frames read. */
  heard: number;
  blocks: Set<number>;
}

/**
 * Reads cimbar codes from `video` (opened by the camera's owner) with
 * libcimbar's own worker pool, until closed.
 */
export function cimbarDecoder(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
): TransferDecoder & { readonly stats: CimbarStats } {
  const stats: CimbarStats = {
    heard: 0,
    fresh: 0,
    rejected: 0,
    frames: 0,
    noCode: 0,
    unreadable: 0,
    errors: 0,
  };
  const heardListeners = new Set<(h: TransferHeard) => void>();
  const completeListeners = new Set<
    (transferId: number, bundle: Uint8Array, unit?: TransferHeard) => void
  >();
  const tallies = new Map<number, Tally>();
  const complete = new Set<number>();
  /** The transfer cimbar is assembling, and its share from cimbar's report. */
  let current: number | undefined;
  let share = 0;
  const stop = new AbortController();
  const fail = (message: string) => {
    stats.errors++;
    stats.lastError = message;
  };

  const run = async () => {
    const m = await load(canvas);
    // A new sink: an unfinished stream from an earlier receive would hold
    // its slot (encode id & 7) and turn away a new transfer of another size.
    m._cimbard_configure_decode(4);
    m._cimbard_configure_decode(MODE_B);
    const sink = m._malloc(m._cimbard_get_bufsize());
    const report = m._malloc(1024);
    const count = Math.max(
      3,
      Math.min(navigator.hardwareConcurrency / 2 + 1, 6),
    );
    const workers = Array.from({ length: count }, () => new Worker(WORKER));
    const pending = workers.map(() => 0);
    let inFlight = 0;
    let next = 0;

    const onReply = (data: WorkerReply) => {
      if (!data.buff?.length) {
        if (data.failed_extract) stats.noCode++;
        else if (data.nodata) stats.unreadable++;
        else fail(String(data.res ?? data.error ?? "no bytes"));
        return;
      }
      stats.heard++;
      const { encodeId: transferId, blockId } = cimbarHeader(data.buff);
      if (complete.has(transferId)) return;
      const t = tallies.get(transferId) ??
        { highest: -1, heard: 0, blocks: new Set() };
      tallies.set(transferId, t);
      const isNew = !t.blocks.has(blockId);
      if (isNew) {
        t.blocks.add(blockId);
        t.heard++;
        stats.fresh++;
      }
      t.highest = Math.max(t.highest, blockId);
      current = transferId;
      m.HEAPU8.set(data.buff, sink);
      // The file id on completion, 0 short of it, -1 for a finished file; an int64, so a bigint in some builds.
      const res = Number(m._cimbard_fountain_decode(sink, data.buff.length));
      try {
        const len = m._cimbard_get_report(report, 1024);
        const shares = JSON.parse(
          new TextDecoder().decode(m.HEAPU8.slice(report, report + len)),
        );
        // ponytail: cimbar reports one share per stream, unnamed; one
        // transfer at a time is the case, so the largest is taken as ours.
        if (Array.isArray(shares)) share = Math.max(...shares, 0);
      } catch { /* the report is prose until a stream starts */ }
      const heard: TransferHeard = {
        transferId,
        fresh: isNew ? 1 : 0,
        counting: true,
      };
      if (res > 0) {
        complete.add(transferId);
        const bundle = readFile(m, res >>> 0);
        for (const l of completeListeners) l(transferId, bundle, heard);
      } else if (res === 0 || res === -1) {
        for (const l of heardListeners) l(heard);
      } else {
        fail(`fountain decode ${res}`);
      }
    };

    // An aborted wasm (out of memory, then out-of-bounds on every call)
    // never recovers, so a crashed decoder is replaced, not kept failing.
    const listen = (i: number) => {
      workers[i].onmessage = (e) => {
        if (e.data?.type === "startWasm") return; // a replacement coming up
        pending[i]--;
        inFlight--;
        onReply(e.data);
        if (/Aborted|Out of bounds/.test(String(e.data?.res ?? ""))) {
          workers[i].terminate();
          inFlight -= pending[i]; // frames it held will never answer
          pending[i] = 0;
          workers[i] = new Worker(WORKER);
          listen(i);
        }
      };
      workers[i].onerror = (e) => {
        pending[i]--;
        inFlight--;
        fail(`worker: ${e.message}`);
      };
    };

    try {
      await Promise.race([
        Promise.all(workers.map((w) =>
          new Promise<void>((resolve) => {
            w.onmessage = (e) => e.data?.type === "startWasm" && resolve();
          })
        )),
        aborted(stop.signal),
      ]);
      workers.forEach((_, i) => listen(i));
      while (!stop.signal.aborted) {
        await videoFrame(video);
        // One frame per worker in flight; a stale frame is worth less than a fresh one.
        if (inFlight >= workers.length || !video.videoWidth) continue;
        try {
          const frame = await grab(video);
          stats.frames++;
          inFlight++;
          const i = next++ % workers.length;
          pending[i]++;
          workers[i].postMessage(
            { ...frame.message, mode: MODE_B },
            frame.transfer,
          );
        } catch (err) {
          fail(`frame grab: ${err}`); // one bad grab must not end the receive
        }
      }
    } finally {
      for (const w of workers) w.terminate();
      m._free(report);
      m._free(sink);
    }
  };
  run().catch((err) => fail(`cimbar: ${err}`));

  const listen = <T>(set: Set<T>, l: T) => {
    set.add(l);
    return () => void set.delete(l);
  };

  return {
    name: "cimbar",
    stats,
    onHeard: (l) => listen(heardListeners, l),
    onComplete: (l) => listen(completeListeners, l),
    ack(transferId) {
      const t = tallies.get(transferId);
      if (!t) return undefined;
      // ponytail: no share, so a sender does not adapt cimbar's rate yet;
      // it would need frames per block id, which cimbar does not report.
      return { k: 0, highest: t.highest, heard: t.heard, runs: [] };
    },
    status: () =>
      current === undefined || complete.has(current)
        ? []
        : [{ transferId: current, progress: Math.min(share, 1) }],
    forget: (transferId) => void tallies.delete(transferId),
    close() {
      stop.abort();
      heardListeners.clear();
      completeListeners.clear();
    },
  };
}

function videoFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const v = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(resolve);
    else requestAnimationFrame(() => resolve());
  });
}

// What cimbar's recv-worker takes: raw pixels it can read, or an ImageBitmap it converts itself.
type FrameMessage = {
  type: "proc";
  width: number;
  height: number;
  format: string;
  pixels?: Uint8Array;
  bitmap?: ImageBitmap;
};

let useVideoFrame = typeof VideoFrame !== "undefined";

/**
 * One camera frame for the decoders. An NV12 VideoFrame (what an iPhone
 * camera gives) is converted here to RGBA at DECODE_EDGE: on real iPhone
 * frames cimbar's NV12 input missed codes the same pixels read as RGBA, and
 * 4K frames ran its workers out of memory. Other formats go as cimbar's own
 * receiver sends them; an ImageBitmap when there is no VideoFrame.
 */
async function grab(
  video: HTMLVideoElement,
): Promise<{ message: FrameMessage; transfer: Transferable[] }> {
  if (useVideoFrame) {
    let vf: VideoFrame | undefined;
    try {
      vf = new VideoFrame(video, { timestamp: performance.now() * 1000 });
    } catch {
      useVideoFrame = false;
    }
    if (vf) {
      try {
        const width = vf.displayWidth;
        const height = vf.displayHeight;
        if (vf.format === "NV12") {
          const raw = new Uint8Array(vf.allocationSize());
          await vf.copyTo(raw);
          const rgba = nv12ToRgba(raw, width, height, DECODE_EDGE);
          return {
            message: { type: "proc", format: "RGBA", ...rgba },
            transfer: [rgba.pixels.buffer],
          };
        }
        const native = vf.format === "I420";
        const options: VideoFrameCopyToOptions = native
          ? {}
          : { format: "RGBA" };
        const pixels = new Uint8Array(vf.allocationSize(options));
        await vf.copyTo(pixels, options);
        let format = native ? vf.format! : "RGBA";
        if (format === "RGBA" && pixels.length !== width * height * 4) {
          format = vf.format ?? "RGBA";
        }
        return {
          message: { type: "proc", pixels, format, width, height },
          transfer: [pixels.buffer],
        };
      } finally {
        vf.close();
      }
    }
  }
  const bitmap = await createImageBitmap(video);
  return {
    message: {
      type: "proc",
      bitmap,
      format: "RGBA",
      width: bitmap.width,
      height: bitmap.height,
    },
    transfer: [bitmap],
  };
}

function readFile(m: Wasm, id: number): Uint8Array {
  const size = m._cimbard_get_decompress_bufsize();
  const buf = m._malloc(size);
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const n = m._cimbard_decompress_read(id, buf, size);
      if (n <= 0) break;
      parts.push(m.HEAPU8.slice(buf, buf + n));
    }
  } finally {
    m._free(buf);
  }
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
