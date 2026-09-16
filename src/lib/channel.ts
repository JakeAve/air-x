export interface PacketSource {
  /** Delivers every packet heard; returns an unsubscribe function. */
  onPacket(listener: (bytes: Uint8Array) => void): () => void;
}

export interface PacketChannel extends PacketSource {
  /** Presents each packet once, in order. */
  send(packets: Uint8Array[], signal: AbortSignal): Promise<void>;
}

export interface PacketDisplay {
  /** Presents packets, e.g. cycling frames of one QR code. */
  show(packets: Uint8Array[]): void;
  /** Stops presenting. */
  clear(): void;
}
