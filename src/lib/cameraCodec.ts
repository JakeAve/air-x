import { sleep } from "./abort.ts";
import type { PacketDisplay } from "./channel.ts";
import { blockCount } from "./fountain/symbols.ts";
import { encodePacket, PacketType, type Run } from "./packet.ts";
import { dataBytes, QR_PACKET_BYTES } from "./protocol.ts";
import type { CameraRate } from "./rate.ts";
import { SymbolStream } from "./symbolStream.ts";

/** Packets the sender expects to need: k plus 10 % repair. */
export const OVERHEAD = 1.1;

/** One frame shown. Every field is cumulative except `symbolIds`, the frame's own. */
export interface CameraFrame {
  frames: number;
  /** Fresh units sent: what `silentAfter` counts. */
  fresh: number;
  freshBytes: number;
  /** The rate this frame went out at. */
  rate: CameraRate;
  symbolIds?: number[];
}

/** A send under way. `done` settles once the signal aborts and the screen is cleared. */
export interface CameraSending {
  setRate(rate: CameraRate): void;
  /** Queues an ack's runs ahead of fresh units; returns how many were new. */
  resend(runs: Run[]): number;
  readonly fresh: number;
  done: Promise<void>;
}

export interface CameraEncoder {
  readonly name: string;
  /** Bits of transfer id the codec's frames carry; 16, a packet's, when left out. */
  readonly idBits?: number;
  start(
    bundle: Uint8Array,
    transferId: number,
    rate: CameraRate,
    signal: AbortSignal,
    onFrame?: (f: CameraFrame) => void,
  ): CameraSending;
  /** Expected seconds to send a bundle of this size at this rate. */
  seconds(bundleBytes: number, rate: CameraRate): number;
}

/** Expected seconds to send a bundle of this size by QR at this rate. */
export const qrSeconds = (bundleBytes: number, rate: CameraRate): number =>
  Math.ceil(OVERHEAD * blockCount(bundleBytes, QR_PACKET_BYTES)) /
  ((rate.packetsPerCode ?? 1) * rate.fps);

/** QR codes of `packetsPerCode` 128-byte packets at `fps`, queued blocks first. */
export function qrEncoder(display: PacketDisplay): CameraEncoder {
  return {
    name: "qr",
    start(bundle, transferId, rate, signal, onFrame) {
      const stream = new SymbolStream(bundle, transferId, QR_PACKET_BYTES);
      const blockBytes = dataBytes(QR_PACKET_BYTES, stream.k);
      let frames = 0;
      const run = async () => {
        // Let `start` return first, so an ack heard in `onFrame` finds its sending.
        await null;
        try {
          while (!signal.aborted) {
            const shown = rate;
            const symbols = stream.next(
              shown.packetsPerCode ?? 1,
              PacketType.Data,
            );
            display.show(symbols.map(encodePacket));
            frames++;
            onFrame?.({
              frames,
              fresh: stream.fresh,
              freshBytes: stream.fresh * blockBytes,
              rate: shown,
              symbolIds: symbols.map((s) => s.symbolId),
            });
            await sleep(1000 / rate.fps, signal);
          }
        } catch (err) {
          if (!signal.aborted) throw err;
        } finally {
          display.clear();
        }
      };
      return {
        setRate: (next) => rate = next,
        resend: (runs) => stream.resend(runs),
        get fresh() {
          return stream.fresh;
        },
        done: run(),
      };
    },
    seconds: qrSeconds,
  };
}
