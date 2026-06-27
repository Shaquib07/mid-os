/**
 * Small byte/hex helpers used across the Casper x402 core.
 * No external deps so they are trivially portable and testable.
 */

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) {
    throw new Error(`invalid hex length ${clean.length}`)
  }
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.substr(i * 2, 2), 16)
    if (Number.isNaN(byte)) throw new Error(`invalid hex at offset ${i * 2}`)
    out[i] = byte
  }
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/**
 * Encode a non-negative integer (decimal string or bigint) as a big-endian
 * 32-byte (uint256) value. Matches Rust `U256::to_big_endian`.
 */
export function toUint256Be(value: string | bigint): Uint8Array {
  let v = typeof value === 'bigint' ? value : BigInt(value)
  if (v < 0n) throw new Error('uint256 cannot be negative')
  const out = new Uint8Array(32)
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  if (v > 0n) throw new Error('value exceeds uint256')
  return out
}

/** Parse a big-endian byte array back into a bigint. */
export function fromBeBytes(bytes: Uint8Array | number[]): bigint {
  let v = 0n
  for (const b of bytes) v = (v << 8n) | BigInt(b)
  return v
}

/** Constant-time-ish equality for fixed-size byte arrays. */
export function bytesEqual(a: Uint8Array | number[], b: Uint8Array | number[]): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}
