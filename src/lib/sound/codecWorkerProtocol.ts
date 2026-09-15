// Messages between the page and the codec worker, which hosts ggwave and the
// QR decoder so neither the UI thread nor the main bundle carries them.
import type { SoundProtocol } from "./ggwave.ts";

export type ToWorker =
  | { type: "init"; sampleRate: number }
  | {
    type: "encodeSound";
    id: number;
    packet: Uint8Array;
    protocol: SoundProtocol;
  }
  | { type: "sound"; samples: Float32Array<ArrayBuffer> }
  | {
    type: "qr";
    id: number;
    width: number;
    height: number;
    data: Uint8ClampedArray;
  };

export type FromWorker =
  | { type: "ready" }
  | { type: "encoded"; id: number; samples: Float32Array<ArrayBuffer> }
  | { type: "soundPackets"; packets: Uint8Array[] }
  | { type: "qrPackets"; id: number; packets: Uint8Array[] }
  | { type: "error"; message: string };
