/**
 * Casper address helpers — mirrors `x402-eip712/src/lib.rs` in casper-x402-poc.
 *
 * A Casper `Address` is 33 bytes: a 1-byte tag followed by a 32-byte hash.
 *   - tag 0x00 → account-hash  (rendered "account-hash-<hex>")
 *   - tag 0x01 → contract/package hash (rendered "hash-<hex>")
 */
import { bytesToHex, hexToBytes } from './bytes.js'

export const ACCOUNT_TAG = 0x00
export const CONTRACT_TAG = 0x01

/** Build a 33-byte tagged Casper address from a tag and 32 raw hash bytes. */
export function casperAddressFromParts(tag: number, hash32: Uint8Array): Uint8Array {
  if (hash32.length !== 32) throw new Error('hash must be 32 bytes')
  const out = new Uint8Array(33)
  out[0] = tag
  out.set(hash32, 1)
  return out
}

/** account-hash address (tag 0x00). */
export function casperAccountFromBytes(accountHash32: Uint8Array): Uint8Array {
  return casperAddressFromParts(ACCOUNT_TAG, accountHash32)
}

/** contract/package-hash address (tag 0x01). */
export function casperContractFromBytes(contractHash32: Uint8Array): Uint8Array {
  return casperAddressFromParts(CONTRACT_TAG, contractHash32)
}

/** Extract the raw 32-byte hash from a 33-byte tagged Casper address. */
export function casperAddressToBytes(addr33: Uint8Array): Uint8Array {
  if (addr33.length !== 33) throw new Error('Casper address must be 33 bytes')
  const tag = addr33[0]
  if (tag !== ACCOUNT_TAG && tag !== CONTRACT_TAG) {
    throw new Error(`invalid Casper address: unexpected tag byte 0x${tag.toString(16)}`)
  }
  return addr33.slice(1)
}

/**
 * Human-readable rendering, matching `format_casper_address` in the Rust crate.
 *   - 0x00 → "account-hash-<hex>"
 *   - 0x01 → "hash-<hex>"
 */
export function formatCasperAddress(addr33: Uint8Array): string {
  const tag = addr33[0]
  const hex = bytesToHex(addr33.slice(1))
  if (tag === ACCOUNT_TAG) return `account-hash-${hex}`
  if (tag === CONTRACT_TAG) return `hash-${hex}`
  return `unknown-${tag.toString(16).padStart(2, '0')}-${hex}`
}

/**
 * Parse a `hash-<hex>` or `account-hash-<hex>` (or bare hex) into a 33-byte
 * tagged address. Accepts the forms used by `payTo`/`asset` in requirements.
 */
export function parseCasperAddress(value: string): Uint8Array {
  const v = value.trim()
  if (v.startsWith('account-hash-')) {
    return casperAccountFromBytes(hexToBytes(v.slice('account-hash-'.length)))
  }
  if (v.startsWith('hash-')) {
    return casperContractFromBytes(hexToBytes(v.slice('hash-'.length)))
  }
  // Bare hex: 33 bytes (tagged) or 32 bytes (assume account hash).
  const bytes = hexToBytes(v)
  if (bytes.length === 33) return bytes
  if (bytes.length === 32) return casperAccountFromBytes(bytes)
  throw new Error(`cannot parse Casper address from "${value}"`)
}
