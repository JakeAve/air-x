import { assert, assertEquals, assertThrows } from "@std/assert";
import { SoundEncoder } from "./soundEncoder.ts";
import { SoundDecoder } from "./soundDecoder.ts";
import { decodePacket, encodePacket, PacketType } from "@/lib/packet.ts";
import { DATA_BYTES, PACKET_BYTES, SOUND_SAMPLE_RATE } from "@/lib/protocol.ts";
import { PACKET_SECONDS, type SoundProtocol } from "./ggwave.ts";

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function withSilence(samples: Float32Array, noise = 0): Float32Array {
  const pad = SOUND_SAMPLE_RATE / 4;
  const out = new Float32Array(pad + samples.length + pad);
  out.set(samples, pad);
  if (noise > 0) {
    const random = mulberry32(1);
    for (let i = 0; i < out.length; i++) out[i] += gaussian(random) * noise;
  }
  return out;
}

function decodeAll(
  decoder: SoundDecoder,
  samples: Float32Array,
  chunk: number,
): Uint8Array[] {
  const packets: Uint8Array[] = [];
  for (let off = 0; off < samples.length; off += chunk) {
    packets.push(
      ...decoder.push(
        samples.subarray(off, Math.min(off + chunk, samples.length)),
      ),
    );
  }
  return packets;
}

const packet = encodePacket({
  type: PacketType.Data,
  transferId: 1234,
  k: 5,
  symbolId: 2,
  data: new Uint8Array(DATA_BYTES).map((_, i) => (i * 53 + 0x80) & 0xff),
});

const PROTOCOLS: SoundProtocol[] = [
  "fastest",
  "fast",
  "normal",
  "ultrasound-fastest",
  "ultrasound-fast",
  "ultrasound-normal",
];

Deno.test("packet round trip through encode, sound, and decodePacket via 128-sample pushes", async () => {
  const encoder = await SoundEncoder.create();
  const decoder = await SoundDecoder.create();
  const decoded = decodeAll(decoder, withSilence(encoder.encode(packet)), 128);
  assertEquals(decoded.length, 1);
  assertEquals(decoded[0], packet);
  assertEquals(decodePacket(decoded[0]), decodePacket(packet));
  encoder.dispose();
  decoder.dispose();
});

Deno.test("every protocol decodes with a single decoder", async () => {
  const encoder = await SoundEncoder.create();
  const decoder = await SoundDecoder.create();
  for (const protocol of PROTOCOLS) {
    encoder.protocol = protocol;
    assertEquals(
      decodeAll(decoder, withSilence(encoder.encode(packet)), 1024),
      [packet],
      protocol,
    );
  }
  encoder.dispose();
  decoder.dispose();
});

Deno.test("PACKET_SECONDS matches measured encode duration within 2%", async () => {
  const encoder = await SoundEncoder.create();
  for (const protocol of PROTOCOLS) {
    encoder.protocol = protocol;
    const seconds = encoder.encode(packet).length / SOUND_SAMPLE_RATE;
    const expected = PACKET_SECONDS[protocol];
    const error = Math.abs(seconds - expected) / expected;
    assert(error < 0.02, `${protocol}: got ${seconds}s, expected ${expected}s`);
  }
  encoder.dispose();
});

Deno.test("encoder rejects packets of the wrong size", async () => {
  const encoder = await SoundEncoder.create();
  assertThrows(
    () => encoder.encode(new Uint8Array(PACKET_BYTES - 1)),
    RangeError,
  );
  encoder.dispose();
});

Deno.test("60s of seeded Gaussian noise yields no packet that passes decodePacket", async () => {
  const random = mulberry32(42);
  const samples = new Float32Array(60 * SOUND_SAMPLE_RATE);
  for (let i = 0; i < samples.length; i++) samples[i] = gaussian(random) * 0.2;

  const decoder = await SoundDecoder.create();
  const rawDecodes = decodeAll(decoder, samples, 4096);
  const validPackets = rawDecodes.filter((bytes) => decodePacket(bytes));
  console.log(
    `60s Gaussian noise: ${rawDecodes.length} raw ggwave decode(s), ${validPackets.length} passed decodePacket`,
  );
  assertEquals(validPackets, []);
  decoder.dispose();
});
