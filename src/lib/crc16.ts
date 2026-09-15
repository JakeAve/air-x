// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF). Check value for "123456789" is 0x29B1.

const TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i << 8;
  for (let bit = 0; bit < 8; bit++) {
    crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  TABLE[i] = crc;
}

export function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const b of bytes) crc = ((crc << 8) ^ TABLE[(crc >> 8) ^ b]) & 0xffff;
  return crc;
}
