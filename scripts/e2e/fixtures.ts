// Builds a fake-microphone WAV fixture from the real codec: a single-item
// text bundle sent as fountain packets 0..k+3 on the fastest sound protocol.
// Chromium loops the file, so one pass is enough.
import { encodeBundle } from "@/lib/bundle.ts";
import { Encoder } from "@/lib/fountain/encoder.ts";
import { encodePacket } from "@/lib/packet.ts";
import { SOUND_SAMPLE_RATE } from "@/lib/protocol.ts";
import { SoundEncoder } from "@/lib/sound/soundEncoder.ts";

export const FIXTURE_TEXT = "hello air x";

const TRANSFER_ID = 1;
const GAP_SECONDS = 0.15;
const SILENCE_SECONDS = 0.5;

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

export async function writeFixtures(dir: string): Promise<{ wav: string }> {
  const wav = `${dir}/mic.wav`;
  await Deno.writeFile(wav, await microphoneWav());
  return { wav };
}

if (import.meta.main) {
  console.log(await writeFixtures(Deno.args[0] ?? "."));
}
