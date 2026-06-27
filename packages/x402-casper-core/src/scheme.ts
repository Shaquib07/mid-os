/**
 * x402 header (de)serialization for Casper. The resource server sends a base64
 * `Payment-Required` header (a `PaymentRequired` JSON) and expects a base64
 * `Payment-Signature` header (a `PaymentPayload` JSON) back.
 */
import type {
  CasperAuthorization,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  ResourceInfo
} from './types.js'

export const HEADER_PAYMENT_REQUIRED = 'Payment-Required'
export const HEADER_PAYMENT_SIGNATURE = 'Payment-Signature'
export const HEADER_PAYMENT_RESPONSE = 'Payment-Response'

const toB64 = (s: string): string => Buffer.from(s, 'utf-8').toString('base64')
const fromB64 = (s: string): string => Buffer.from(s, 'base64').toString('utf-8')

export function encodeJsonHeader(value: unknown): string {
  return toB64(JSON.stringify(value))
}

export function decodeJsonHeader<T>(header: string): T {
  return JSON.parse(fromB64(header)) as T
}

export function encodePaymentRequired(value: PaymentRequired): string {
  return encodeJsonHeader(value)
}

export function decodePaymentRequired(header: string): PaymentRequired {
  return decodeJsonHeader<PaymentRequired>(header)
}

export function decodePaymentSignature(header: string): PaymentPayload {
  return decodeJsonHeader<PaymentPayload>(header)
}

/** Build the `PaymentPayload` and its base64 `Payment-Signature` header value. */
export function buildPaymentSignatureHeader(params: {
  x402Version: number
  accepted: PaymentRequirements
  authorization: CasperAuthorization
  resource?: ResourceInfo
}): { payload: PaymentPayload; header: string } {
  const payload: PaymentPayload = {
    x402Version: params.x402Version,
    resource: params.resource,
    accepted: params.accepted,
    payload: params.authorization
  }
  return { payload, header: encodeJsonHeader(payload) }
}

/** Pick the first Casper `exact` accept this wallet can fulfil. */
export function selectCasperAccept(req: PaymentRequired): PaymentRequirements | undefined {
  return req.accepts.find(
    (a) => a.scheme === 'exact' && a.network.startsWith('casper:')
  )
}
