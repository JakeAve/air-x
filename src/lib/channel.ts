export interface PacketChannel {
  /** Presents each packet once, in order. */
  send(packets: Uint8Array[], signal: AbortSignal): Promise<void>;
  /** Delivers every packet heard; returns an unsubscribe function. */
  onPacket(listener: (bytes: Uint8Array) => void): () => void;
}
