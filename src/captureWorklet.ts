/// <reference path="../types/audioWorklet.d.ts" />
// Forwards microphone samples to the page in blocks the sound decoder can use
// whole. Outputs silence so it can sit in the graph without being heard.

const BLOCK = 1024;

class CaptureProcessor extends AudioWorkletProcessor {
  #block = new Float32Array(BLOCK);
  #filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(BLOCK - this.#filled, channel.length - offset);
      this.#block.set(channel.subarray(offset, offset + take), this.#filled);
      this.#filled += take;
      offset += take;
      if (this.#filled === BLOCK) {
        const out = this.#block.slice();
        this.port.postMessage(out, [out.buffer]);
        this.#filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("airx-capture", CaptureProcessor);
