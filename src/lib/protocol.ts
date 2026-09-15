export const PROTOCOL_VERSION = 1;

/** Packet layout: version 4b | type 4b | transferId 16b | k 24b | symbolId 24b | data | crc16. */
export const PACKET_BYTES = 64;
export const PACKET_HEADER_BYTES = 9;
export const PACKET_CRC_BYTES = 2;
export const DATA_BYTES = PACKET_BYTES - PACKET_HEADER_BYTES - PACKET_CRC_BYTES;

/** Up to this many blocks, repair symbols are dense random rows instead of LT. */
export const DENSE_MAX_K = 128;

export const MAX_K = 2 ** 24 - 1;
export const MAX_SYMBOL_ID = 2 ** 24 - 1;

/** A decoder ignores any packet whose k implies a bundle bigger than this. */
export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

/** decodeBundle aborts decompression once the output would exceed this. */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
