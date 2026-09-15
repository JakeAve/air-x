// Builds fake-device fixtures from the real codec: a WAV for Chromium's fake
// microphone (a single-item text bundle sent as fountain packets 0..k+3 on
// the fastest sound protocol) and a y4m for its fake camera (a single-item
// binary bundle sent as QR codes of 8 packets each, symbols 0..k+15).
// Chromium loops both files, so one pass through each is enough.
import { encodeBundle } from "@/lib/bundle.ts";
import { Encoder } from "@/lib/fountain/encoder.ts";
import { encodePacket } from "@/lib/packet.ts";
import { SOUND_SAMPLE_RATE } from "@/lib/protocol.ts";
import { SoundEncoder } from "@/lib/sound/soundEncoder.ts";
import { encodeQrPackets } from "@/lib/qr/qrEncoder.ts";
import { rasterize } from "@/lib/qr/rasterize.ts";

export const FIXTURE_TEXT = "hello air x";
export const FIXTURE_FILE_NAME = "fixture.bin";

const TRANSFER_ID = 1;
const GAP_SECONDS = 0.15;
const SILENCE_SECONDS = 0.5;

const QR_TRANSFER_ID = 2;
const QR_ITEM_BYTES = 2048;
const QR_EXTRA_SYMBOLS = 16;
const QR_PACKETS_PER_CODE = 8;
const QR_HOLD_FRAMES = 10;
const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const VIDEO_FPS = 30;
const QR_MAX_HEIGHT = 680;

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function microphoneWav(): Promise<Uint8Array> {
  const bundle = await encodeBundle([{
    name: "message.txt",
    type: "text/plain",
    bytes: new TextEncoder().encode(FIXTURE_TEXT),
  }]);
  const fountain = new Encoder(bundle, TRANSFER_ID);
  const soundEncoder = await SoundEncoder.create({
    sampleRate: SOUND_SAMPLE_RATE,
  });

  const parts: Float32Array[] = [
    new Float32Array(SOUND_SAMPLE_RATE * SILENCE_SECONDS),
  ];
  const gap = new Float32Array(SOUND_SAMPLE_RATE * GAP_SECONDS);
  for (let symbolId = 0; symbolId <= fountain.k + 3; symbolId++) {
    parts.push(soundEncoder.encode(encodePacket(fountain.next())), gap);
  }
  soundEncoder.dispose();

  const pcm = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const part of parts) {
    for (const v of part) {
      pcm[pos++] = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
    }
  }
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string) =>
    [...text].forEach((c, i) => wav[offset + i] = c.charCodeAt(0));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SOUND_SAMPLE_RATE, true);
  view.setUint32(28, SOUND_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  wav.set(new Uint8Array(pcm.buffer), 44);
  return wav;
}

function qrScale(modules: number): number {
  return Math.max(1, Math.floor(QR_MAX_HEIGHT / (modules + 8)));
}

async function cameraY4m(): Promise<Uint8Array> {
  const random = mulberry32(QR_TRANSFER_ID);
  const bytes = new Uint8Array(QR_ITEM_BYTES);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (random() * 256) | 0;
  const bundle = await encodeBundle([{
    name: FIXTURE_FILE_NAME,
    type: "application/octet-stream",
    bytes,
  }]);
  const fountain = new Encoder(bundle, QR_TRANSFER_ID);
  const totalSymbols = fountain.k + QR_EXTRA_SYMBOLS;

  const text = new TextEncoder();
  const header = text.encode(
    `YUV4MPEG2 W${VIDEO_WIDTH} H${VIDEO_HEIGHT} F${VIDEO_FPS}:1 Ip A1:1 C420jpeg\n`,
  );
  const tag = text.encode("FRAME\n");
  const chroma = new Uint8Array((VIDEO_WIDTH / 2) * (VIDEO_HEIGHT / 2)).fill(
    128,
  );

  const chunks: Uint8Array[] = [header];
  let sent = 0;
  while (sent < totalSymbols) {
    const count = Math.min(QR_PACKETS_PER_CODE, totalSymbols - sent);
    const packets = Array.from(
      { length: count },
      () => encodePacket(fountain.next()),
    );
    sent += count;
    const matrix = encodeQrPackets(packets, "medium");
    const image = rasterize(matrix, qrScale(matrix.length));
    const luma = new Uint8Array(VIDEO_WIDTH * VIDEO_HEIGHT).fill(255);
    const left = (VIDEO_WIDTH - image.width) >> 1;
    const top = (VIDEO_HEIGHT - image.height) >> 1;
    for (let y = 0; y < image.height; y++) {
      const row = (top + y) * VIDEO_WIDTH + left;
      for (let x = 0; x < image.width; x++) {
        luma[row + x] = image.data[(y * image.width + x) * 4];
      }
    }
    for (let f = 0; f < QR_HOLD_FRAMES; f++) {
      chunks.push(tag, luma, chroma, chroma);
    }
  }

  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

export async function writeFixtures(
  dir: string,
): Promise<{ wav: string; y4m: string }> {
  const wav = `${dir}/mic.wav`;
  const y4m = `${dir}/cam.y4m`;
  await Deno.writeFile(wav, await microphoneWav());
  await Deno.writeFile(y4m, await cameraY4m());
  return { wav, y4m };
}

if (import.meta.main) {
  console.log(await writeFixtures(Deno.args[0] ?? "."));
}
