// Hand-written types for the npm `ggwave` package, which ships none.
// Mirrors bindings/javascript/emscripten.cpp in ggerganov/ggwave 0.4.x.

export interface GgwaveSampleFormat {
  value: number;
}

export interface GgwaveProtocolId {
  value: number;
}

export interface GgwaveParameters {
  /** -1 for variable-length payloads, otherwise the fixed byte length (max 64). */
  payloadLength: number;
  sampleRateInp: number;
  sampleRateOut: number;
  sampleRate: number;
  samplesPerFrame: number;
  soundMarkerThreshold: number;
  sampleFormatInp: GgwaveSampleFormat;
  sampleFormatOut: GgwaveSampleFormat;
  operatingMode: number;
}

export type GgwaveInstance = number;

export interface GgwaveModule {
  getDefaultParameters(): GgwaveParameters;
  init(params: GgwaveParameters): GgwaveInstance;
  free(instance: GgwaveInstance): void;
  /**
   * `payload` may be raw bytes; a string is UTF-8 encoded first.
   * Returns the waveform as raw bytes in `sampleFormatOut` (float32 by
   * default, so four bytes per sample). The view aliases WASM memory and is
   * only valid until the next call.
   */
  encode(
    instance: GgwaveInstance,
    payload: Uint8Array | string,
    protocol: GgwaveProtocolId,
    volume: number,
  ): Int8Array;
  /**
   * Feed raw sample bytes in `sampleFormatInp`. Returns the decoded payload
   * bytes, or an empty view when no complete message was found.
   */
  decode(instance: GgwaveInstance, samples: Uint8Array | Int8Array): Uint8Array;
  rxToggleProtocol(protocol: GgwaveProtocolId, state: number): void;
  txToggleProtocol(protocol: GgwaveProtocolId, state: number): void;
  enableLog(): void;
  disableLog(): void;
  ProtocolId: {
    GGWAVE_PROTOCOL_AUDIBLE_NORMAL: GgwaveProtocolId;
    GGWAVE_PROTOCOL_AUDIBLE_FAST: GgwaveProtocolId;
    GGWAVE_PROTOCOL_AUDIBLE_FASTEST: GgwaveProtocolId;
    GGWAVE_PROTOCOL_ULTRASOUND_NORMAL: GgwaveProtocolId;
    GGWAVE_PROTOCOL_ULTRASOUND_FAST: GgwaveProtocolId;
    GGWAVE_PROTOCOL_ULTRASOUND_FASTEST: GgwaveProtocolId;
    GGWAVE_PROTOCOL_DT_NORMAL: GgwaveProtocolId;
    GGWAVE_PROTOCOL_DT_FAST: GgwaveProtocolId;
    GGWAVE_PROTOCOL_DT_FASTEST: GgwaveProtocolId;
  };
  SampleFormat: {
    GGWAVE_SAMPLE_FORMAT_UNDEFINED: GgwaveSampleFormat;
    GGWAVE_SAMPLE_FORMAT_U8: GgwaveSampleFormat;
    GGWAVE_SAMPLE_FORMAT_I8: GgwaveSampleFormat;
    GGWAVE_SAMPLE_FORMAT_U16: GgwaveSampleFormat;
    GGWAVE_SAMPLE_FORMAT_I16: GgwaveSampleFormat;
    GGWAVE_SAMPLE_FORMAT_F32: GgwaveSampleFormat;
  };
}

export interface GgwaveModuleOverrides {
  /** Receives the C side's stdout lines; the encode binding prints one per call. */
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}

declare function ggwaveFactory(
  overrides?: GgwaveModuleOverrides,
): Promise<GgwaveModule>;
export default ggwaveFactory;
