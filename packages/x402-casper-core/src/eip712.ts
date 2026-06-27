/**
 * EIP-712 typed-data hashing for Casper x402 — a faithful TypeScript port of
 * the `casper-eip-712` Rust crate (encoding.rs / domain.rs / hash.rs) as used
 * by odradev/casper-x402-poc.
 *
 * Keeping signer (MidOS wallet) and verifier (facilitator) on this single
 * implementation guarantees they cannot drift. The port also matches the Rust
 * crate byte-for-byte so the same signature is accepted by the on-chain
 * CEP-18 `transfer_with_authorization` entry point.
 */
import { keccak_256 } from '@noble/hashes/sha3'
import { concatBytes, toUint256Be } from './bytes.js'

export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data)
}

// ─── Field encoders (32-byte EIP-712 slots) ──────────────────────────────────

/** Casper 33-byte address → keccak256(tag ++ hash). */
export function encodeCasperAddress(addr33: Uint8Array): Uint8Array {
  return keccak256(addr33)
}

/** uint256 already as 32-byte big-endian → identity. */
export function encodeUint256(be32: Uint8Array): Uint8Array {
  if (be32.length !== 32) throw new Error('uint256 must be 32 bytes')
  return be32
}

/** bytes32 → identity. */
export function encodeBytes32(b32: Uint8Array): Uint8Array {
  if (b32.length !== 32) throw new Error('bytes32 must be 32 bytes')
  return b32
}

/** dynamic string → keccak256(utf8 bytes). */
export function encodeString(value: string): Uint8Array {
  return keccak256(new TextEncoder().encode(value))
}

// ─── Domain separator ─────────────────────────────────────────────────────────

export interface DomainSeparator {
  typeString: string
  typeHash: Uint8Array
  separatorHash: Uint8Array
}

/**
 * Build the x402 domain separator. Mirrors `x402_domain(name, chain_id, token)`:
 * fields are `string name`, `string version="1"`, `string chain_name`,
 * `bytes32 contract_package_hash` — in this exact order.
 */
export function buildX402Domain(params: {
  name: string
  chainName: string
  contractPackageHash: Uint8Array // 32 bytes
}): DomainSeparator {
  const { name, chainName, contractPackageHash } = params
  if (contractPackageHash.length !== 32) {
    throw new Error('contract_package_hash must be 32 bytes')
  }

  const typeString =
    'EIP712Domain(string name,string version,string chain_name,bytes32 contract_package_hash)'
  const typeHash = keccak256(new TextEncoder().encode(typeString))

  const encoded = concatBytes(
    typeHash,
    encodeString(name),
    encodeString('1'),
    encodeString(chainName),
    encodeBytes32(contractPackageHash)
  )
  const separatorHash = keccak256(encoded)

  return { typeString, typeHash, separatorHash }
}

// ─── TransferWithAuthorization struct hash ────────────────────────────────────

export const TRANSFER_TYPE_STRING =
  'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'

export interface TransferFields {
  from33: Uint8Array // tagged 33-byte Casper address
  to33: Uint8Array // tagged 33-byte Casper address
  value: Uint8Array // 32-byte BE
  validAfter: Uint8Array // 32-byte BE
  validBefore: Uint8Array // 32-byte BE
  nonce: Uint8Array // 32 bytes
}

/** hashStruct = keccak256(typeHash ‖ encodeData). */
export function hashTransferStruct(t: TransferFields): Uint8Array {
  const typeHash = keccak256(new TextEncoder().encode(TRANSFER_TYPE_STRING))
  const encodeData = concatBytes(
    encodeCasperAddress(t.from33),
    encodeCasperAddress(t.to33),
    encodeUint256(t.value),
    encodeUint256(t.validAfter),
    encodeUint256(t.validBefore),
    encodeBytes32(t.nonce)
  )
  return keccak256(concatBytes(typeHash, encodeData))
}

/** Final digest = keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct). */
export function hashTypedData(domain: DomainSeparator, t: TransferFields): Uint8Array {
  const prefix = new Uint8Array([0x19, 0x01])
  return keccak256(concatBytes(prefix, domain.separatorHash, hashTransferStruct(t)))
}

/** Convenience: build the 32-byte uint256 value from a decimal string. */
export function uint256FromDecimal(decimal: string): Uint8Array {
  return toUint256Be(decimal)
}
