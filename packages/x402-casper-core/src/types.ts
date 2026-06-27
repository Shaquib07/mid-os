/**
 * x402 wire types for Casper — match the serde JSON produced by
 * odradev/casper-x402-poc `x402-types` so MidOS can interoperate with a real
 * Casper facilitator later.
 *
 * Note on encodings (to match Rust serde):
 *   - `from` / `to` / `payTo` addresses → lowercase hex string of the 33-byte
 *     tagged Casper address (see `serde_address`).
 *   - `value` / `validAfter` / `validBefore` / `nonce` → arrays of 32 byte
 *     numbers (Rust `[u8; 32]` serializes as a JSON array).
 */

/** Rust `[u8; 32]` serializes as a 32-element array of byte numbers. */
export type Bytes32Json = number[]

export interface ResourceInfo {
  url: string
  description?: string
  mimeType?: string
}

/** A single payment option the resource server accepts. */
export interface PaymentRequirements {
  scheme: string // "exact"
  network: string // e.g. "casper:casper-test"
  asset: string // CEP-18 contract, e.g. "hash-<hex>"
  amount: string // atomic units as decimal string
  payTo: string // hex of 33-byte tagged address
  maxTimeoutSeconds: number
  extra?: unknown
}

/** 402 response body / `Payment-Required` header (base64 JSON). */
export interface PaymentRequired {
  x402Version: number
  error?: string
  resource: ResourceInfo
  accepts: PaymentRequirements[]
  extensions?: unknown
}

/** EIP-3009/x402-style transfer authorization (matches Rust `TransferWithAuthorization`). */
export interface TransferWithAuthorization {
  from: string // hex of 33-byte tagged address
  to: string // hex of 33-byte tagged address
  value: Bytes32Json
  validAfter: Bytes32Json
  validBefore: Bytes32Json
  nonce: Bytes32Json
}

/** The signed authorization embedded in `PaymentPayload.payload`. */
export interface CasperAuthorization {
  transfer: TransferWithAuthorization
  public_key: string // hex of tagged public key bytes
  signature: string // hex of tagged signature bytes
}

/** Payload sent with the `Payment-Signature` header (base64 JSON). */
export interface PaymentPayload {
  x402Version: number
  resource?: ResourceInfo
  accepted: PaymentRequirements
  payload: CasperAuthorization
  extensions?: unknown
}

export interface VerifyRequest {
  paymentPayload: PaymentPayload
  paymentRequirements: PaymentRequirements
}

export interface VerifyResponse {
  isValid: boolean
  invalidReason?: string
  payer?: string
}

export interface SettleRequest {
  paymentPayload: PaymentPayload
  paymentRequirements: PaymentRequirements
}

export interface SettleResponse {
  success: boolean
  transaction?: string
  errorReason?: string
  payer?: string
}
