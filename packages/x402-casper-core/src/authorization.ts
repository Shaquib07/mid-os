/**
 * Build, sign, and verify Casper x402 `TransferWithAuthorization` messages.
 *
 * Signing (wallet side) and verification (facilitator side) both live here so
 * they share one EIP-712 implementation. Ported from `demo/src/client.rs`
 * (sign) and `facilitator/src/routes/verify.rs` (verify).
 */
// casper-js-sdk is CommonJS; use default-import interop so this works under
// Node's native ESM as well as bundlers.
import casperSdk from 'casper-js-sdk'
import type { PrivateKey } from 'casper-js-sdk'
const { PublicKey } = casperSdk
import { bytesToHex, hexToBytes, toUint256Be, fromBeBytes, bytesEqual } from './bytes.js'
import {
  casperAccountFromBytes,
  casperAddressToBytes,
  parseCasperAddress,
  formatCasperAddress
} from './address.js'
import {
  buildX402Domain,
  hashTypedData,
  type DomainSeparator,
  type TransferFields
} from './eip712.js'
import type {
  CasperAuthorization,
  PaymentRequirements,
  TransferWithAuthorization,
  VerifyResponse
} from './types.js'

export interface X402DomainParams {
  /** Token name used in the domain, e.g. "Casper X402 Token". */
  name: string
  /** CAIP-2-ish network id, e.g. "casper:casper-test". */
  chainName: string
  /** CEP-18 contract/package hash — "hash-<hex>" or bare 32-byte hex. */
  contractPackageHash: string
}

/** Resolve the EIP-712 domain separator from string params. */
export function resolveDomain(params: X402DomainParams): DomainSeparator {
  const tagged = parseCasperAddress(params.contractPackageHash)
  // The domain uses the raw 32-byte package hash (without the tag byte).
  return buildX402Domain({
    name: params.name,
    chainName: params.chainName,
    contractPackageHash: casperAddressToBytes(tagged)
  })
}

// ─── Wire <-> internal field conversions ──────────────────────────────────────

function fieldsToWire(f: TransferFields): TransferWithAuthorization {
  return {
    from: bytesToHex(f.from33),
    to: bytesToHex(f.to33),
    value: Array.from(f.value),
    validAfter: Array.from(f.validAfter),
    validBefore: Array.from(f.validBefore),
    nonce: Array.from(f.nonce)
  }
}

function wireToFields(t: TransferWithAuthorization): TransferFields {
  return {
    from33: hexToBytes(t.from),
    to33: hexToBytes(t.to),
    value: Uint8Array.from(t.value),
    validAfter: Uint8Array.from(t.validAfter),
    validBefore: Uint8Array.from(t.validBefore),
    nonce: Uint8Array.from(t.nonce)
  }
}

function randomNonce(): Uint8Array {
  const out = new Uint8Array(32)
  globalThis.crypto.getRandomValues(out)
  return out
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000))
}

// ─── Sign ─────────────────────────────────────────────────────────────────────

/**
 * Build a `TransferWithAuthorization` for the given requirements and sign it
 * with the wallet's Ed25519 private key. Returns a `CasperAuthorization` ready
 * to embed in a `PaymentPayload`.
 */
export function buildAndSignAuthorization(params: {
  privateKey: PrivateKey
  requirements: PaymentRequirements
  domain: DomainSeparator
}): CasperAuthorization {
  const { privateKey, requirements, domain } = params
  const publicKey = privateKey.publicKey

  const accountHash = publicKey.accountHash().toBytes() // 32 bytes
  const from33 = casperAccountFromBytes(accountHash)
  const to33 = parseCasperAddress(requirements.payTo)

  const now = nowSeconds()
  const fields: TransferFields = {
    from33,
    to33,
    value: toUint256Be(requirements.amount),
    validAfter: toUint256Be(now - 1n),
    validBefore: toUint256Be(now + BigInt(requirements.maxTimeoutSeconds)),
    nonce: randomNonce()
  }

  const digest = hashTypedData(domain, fields)
  const signature = privateKey.signAndAddAlgorithmBytes(digest) // tagged

  return {
    transfer: fieldsToWire(fields),
    public_key: bytesToHex(publicKey.bytes()),
    signature: bytesToHex(signature)
  }
}

// ─── Verify ─────────────────────────────────────────────────────────────────

/**
 * Off-chain verification of a `CasperAuthorization` against requirements.
 * Mirrors `verify_authorization` in the Rust facilitator.
 */
export function verifyAuthorization(params: {
  auth: CasperAuthorization
  requirements: PaymentRequirements
  domain: DomainSeparator
}): VerifyResponse {
  const { auth, requirements, domain } = params
  try {
    const fields = wireToFields(auth.transfer)

    // 1. Destination matches requirements.
    const expectedTo = casperAddressToBytes(parseCasperAddress(requirements.payTo))
    const actualTo = casperAddressToBytes(fields.to33)
    if (!bytesEqual(actualTo, expectedTo)) {
      return invalid(
        `payment destination mismatch: got ${formatCasperAddress(fields.to33)}, want ${requirements.payTo}`
      )
    }

    // 2. Amount matches requirements.
    const requiredValue = toUint256Be(requirements.amount)
    if (!bytesEqual(fields.value, requiredValue)) {
      return invalid(
        `amount mismatch: got ${fromBeBytes(fields.value)}, want ${requirements.amount}`
      )
    }

    // 3. Time window.
    const now = nowSeconds()
    const validAfter = fromBeBytes(fields.validAfter)
    const validBefore = fromBeBytes(fields.validBefore)
    if (now <= validAfter) return invalid('authorization not yet valid')
    if (now >= validBefore) return invalid('authorization expired')

    // 4. Public key parses and matches `from`.
    const publicKey = PublicKey.fromHex(auth.public_key)
    const derived = publicKey.accountHash().toBytes()
    const fromHash = casperAddressToBytes(fields.from33)
    if (!bytesEqual(derived, fromHash)) {
      return invalid('public key does not match from address')
    }

    // 5. Ed25519 signature over the EIP-712 digest.
    // casper-js-sdk's verifySignature throws on a bad signature rather than
    // returning false, so treat any throw as a failed verification.
    const digest = hashTypedData(domain, fields)
    const sigBytes = hexToBytes(auth.signature) // tagged; verifySignature strips the alg byte
    let signatureOk = false
    try {
      signatureOk = publicKey.verifySignature(digest, sigBytes)
    } catch {
      signatureOk = false
    }
    if (!signatureOk) {
      return invalid('signature verification failed')
    }

    return { isValid: true, payer: formatCasperAddress(fields.from33) }
  } catch (err) {
    return invalid(err instanceof Error ? err.message : String(err))
  }
}

function invalid(reason: string): VerifyResponse {
  return { isValid: false, invalidReason: reason }
}
