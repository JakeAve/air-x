export class Microphone {
  #stream: MediaStream;
  #source: MediaStreamAudioSourceNode;
  #node: AudioWorkletNode;

  private constructor(
    stream: MediaStream,
    source: MediaStreamAudioSourceNode,
    node: AudioWorkletNode,
  ) {
    this.#stream = stream;
    this.#source = source;
    this.#node = node;
  }

  /**
   * Opens the microphone with browser audio processing turned off, since
   * echo cancellation and noise suppression eat data tones. Must be called
   * from a user gesture on iOS.
   */
  static async open(
    context: AudioContext,
    workletUrl: string,
  ): Promise<Microphone> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    await context.audioWorklet.addModule(workletUrl);
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "airx-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    source.connect(node);
    node.connect(context.destination);
    return new Microphone(stream, source, node);
  }

  get settings(): MediaTrackSettings {
    return this.#stream.getAudioTracks()[0]?.getSettings() ?? {};
  }

  onSamples(listener: (samples: Float32Array<ArrayBuffer>) => void): void {
    this.#node.port.onmessage = (
      event: MessageEvent<Float32Array<ArrayBuffer>>,
    ) => listener(event.data);
  }

  close(): void {
    this.#node.port.onmessage = null;
    this.#source.disconnect();
    this.#node.disconnect();
    for (const track of this.#stream.getTracks()) track.stop();
  }
}
