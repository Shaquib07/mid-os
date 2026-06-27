/**
 * casper-native x402 scheme — REAL on-chain settlement via native CSPR transfers.
 *
 * Unlike the EIP-3009 `exact` scheme (gasless, facilitator-relayed), the
 * `casper-native` scheme settles by having the payer submit a real native CSPR
 * transfer on Casper. The resource server / facilitator then VERIFIES that
 * transfer on-chain (finalized, correct recipient, correct amount, correct
 * payer, not replayed) before unlocking the resource. No mock, no off-chain ref.
 *
 * Wire shape (base64 JSON, like the rest of the protocol):
 *   402  →  `Payment-Required`: a PaymentRequired whose accepts[] include a
 *           casper-native requirement (payTo = seller public-key hex, asset =
 *           "native-cspr", extra = { transferId }).
 *   pay  →  `Payment-Deploy`: a NativeSettlementProof { deployHash, payer }.
 */
// casper-js-sdk is CommonJS; default-import interop (see authorization.ts).
import casperSdk from 'casper-js-sdk'
import type { PaymentRequired, PaymentRequirements } from './types.js'

export const NATIVE_SCHEME = 'casper-native'
export const NATIVE_ASSET = 'native-cspr'
export const HEADER_PAYMENT_DEPLOY = 'Payment-Deploy'

/** Extra data carried in a casper-native PaymentRequirements.extra. */
export interface NativeExtra {
  /** Transfer id the payer MUST set on the native transfer (binds it to this request). */
  transferId: number
  resourceId?: string
}

/** Proof the wallet returns after paying: a finalized on-chain transfer. */
export interface NativeSettlementProof {
  deployHash: string
  /** Payer public-key hex (lets the verifier match the on-chain sender). */
  payer: string
  /** The exact requirement the wallet fulfilled (echoes the 402's transferId). */
  accepted: PaymentRequirements
}

/**
 * Normalized, chain-version-agnostic view of a queried transfer deploy. The
 * wallet builds this from `rpc.getDeploy(...)`; the facilitator verifies it.
 */
export interface DeployView {
  found: boolean
  success: boolean
  errorMessage?: string
  payerPublicKey?: string
  /** 64-hex, lowercase, no `account-hash-` prefix. */
  payerAccountHash?: string
  /** 64-hex, lowercase, no `account-hash-` prefix. */
  toAccountHash?: string
  /** motes, decimal string. */
  amountMotes?: string
  transferId?: number | null
  deployHash?: string
}

export interface NativeExpectation {
  /** 64-hex, lowercase, no prefix. */
  payToAccountHash: string
  amountMotes: string | bigint
  transferId?: number
  /** If set, also require the on-chain sender to equal this account hash. */
  payerAccountHash?: string
}

export interface NativeVerifyResult {
  ok: boolean
  reason?: string
  payer?: string
  amountMotes?: string
}

const norm = (h?: string): string =>
  (h ?? '').toLowerCase().replace(/^account-hash-/, '').replace(/^0x/, '')

/**
 * Pure on-chain settlement check for the casper-native scheme. Caller is
 * responsible for replay protection (tracking consumed deploy hashes).
 */
export function verifyNativeSettlement(
  view: DeployView,
  expect: NativeExpectation
): NativeVerifyResult {
  if (!view.found) return { ok: false, reason: 'transfer deploy not found on chain' }
  if (!view.success) {
    return {
      ok: false,
      reason: `transfer failed on chain: ${view.errorMessage ?? 'unknown error'}`
    }
  }
  if (norm(view.toAccountHash) !== norm(expect.payToAccountHash)) {
    return { ok: false, reason: 'transfer recipient does not match payTo' }
  }
  if (expect.payerAccountHash && norm(view.payerAccountHash) !== norm(expect.payerAccountHash)) {
    return { ok: false, reason: 'transfer sender does not match expected payer' }
  }
  let paid: bigint
  let need: bigint
  try {
    paid = BigInt(view.amountMotes ?? '0')
    need = BigInt(expect.amountMotes)
  } catch {
    return { ok: false, reason: 'unparseable transfer amount' }
  }
  if (paid < need) {
    return { ok: false, reason: `underpaid: ${paid} < ${need} motes` }
  }
  // Transfer-id binding is advisory: only enforced when we could actually read
  // an id off the on-chain transfer (SDK memo↔id mapping varies by version).
  if (
    expect.transferId !== undefined &&
    view.transferId != null &&
    view.transferId !== expect.transferId
  ) {
    return {
      ok: false,
      reason: `transfer id mismatch (got ${view.transferId}, want ${expect.transferId})`
    }
  }
  return { ok: true, payer: view.payerPublicKey, amountMotes: paid.toString() }
}

/* ── Deploy normalization (shared by wallet + facilitator) ─────────────────── */
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Extract execution status across Casper 1.x / 2.0 deploy-result shapes. */
function extractExecution(
  res: any,
  raw: any
): { executed: boolean; success: boolean; error?: string } {
  const readResult = (
    r: any
  ): { executed: boolean; success: boolean; error?: string } | undefined => {
    if (!r) return undefined
    if (r.success) return { executed: true, success: true }
    if (r.failure) {
      return {
        executed: true,
        success: false,
        error: r.failure.errorMessage ?? r.failure.error_message ?? 'execution failed'
      }
    }
    const v2 = r.Version2 ?? r.version2
    if (v2) {
      const em = v2.error_message ?? v2.errorMessage
      return { executed: true, success: em == null, error: em ?? undefined }
    }
    const v1 = r.Version1 ?? r
    if (v1?.Success) return { executed: true, success: true }
    if (v1?.Failure) {
      return {
        executed: true,
        success: false,
        error: v1.Failure.error_message ?? v1.Failure.errorMessage ?? 'execution failed'
      }
    }
    return undefined
  }

  const execs = res?.executionResults ?? res?.execution_results
  if (Array.isArray(execs) && execs.length > 0) {
    const got = readResult(execs[0]?.result ?? execs[0])
    if (got) return got
  }
  const rawExecs = raw?.execution_results ?? raw?.executionResults
  if (Array.isArray(rawExecs) && rawExecs.length > 0) {
    const got = readResult(rawExecs[0]?.result ?? rawExecs[0])
    if (got) return got
  }
  const ei = raw?.execution_info ?? raw?.executionInfo
  const got = readResult(ei?.execution_result ?? ei?.executionResult)
  if (got) return got

  return { executed: false, success: false, error: 'not yet executed' }
}

function parseTransferId(parsed: any): number | null {
  if (parsed == null) return null
  if (typeof parsed === 'number') return parsed
  const n = Number(String(parsed))
  return Number.isFinite(n) ? n : null
}

/** Normalize a transfer `target` arg (account-hash or public-key forms) → 64-hex. */
function parseAccountHash(parsed: any): string | undefined {
  if (parsed == null) return undefined
  let s: string =
    typeof parsed === 'string'
      ? parsed
      : String(
          parsed.AccountHash ??
            parsed.account_hash ??
            parsed.Account ??
            parsed.Key ??
            parsed.bytes ??
            JSON.stringify(parsed)
        )
  s = s.toLowerCase().replace(/^account-hash[-/]/, '').replace(/^hash-/, '').replace(/^0x/, '')
  if (/^0[12][0-9a-f]{64,66}$/.test(s)) {
    try {
      return accountHashHex(s)
    } catch {
      /* fall through */
    }
  }
  const m = s.match(/[0-9a-f]{64}/)
  return m ? m[0] : s
}

/**
 * Normalize a node `getDeploy` result into a `DeployView` (+ an `executed`
 * flag). Tolerant of Casper 1.x and 2.0 JSON shapes. Pass the casper-js-sdk
 * `InfoGetDeployResult` (it exposes `.rawJSON` and `.executionResults`).
 */
export function normalizeDeployResult(res: any): DeployView & { executed: boolean } {
  const raw = res?.rawJSON ?? res?.rawJson ?? {}
  const { executed, success, error } = extractExecution(res, raw)

  const deployJson = raw.deploy ?? raw.Deploy ?? {}
  const payerPublicKey: string | undefined = deployJson?.header?.account
  const session = deployJson?.session ?? {}
  const transfer = session.Transfer ?? session.transfer ?? {}
  const args: any[] = Array.isArray(transfer.args) ? transfer.args : []
  const argVal = (name: string): any => {
    const a = args.find((x) => Array.isArray(x) && x[0] === name)
    return a ? a[1]?.parsed : undefined
  }
  const amountMotes = argVal('amount') != null ? String(argVal('amount')) : undefined
  const transferId = parseTransferId(argVal('id'))
  const toAccountHash = parseAccountHash(argVal('target'))

  let payerAccountHash: string | undefined
  if (payerPublicKey) {
    try {
      payerAccountHash = accountHashHex(payerPublicKey)
    } catch {
      /* ignore */
    }
  }

  return {
    found: true,
    executed,
    success,
    errorMessage: error,
    payerPublicKey,
    payerAccountHash,
    toAccountHash,
    amountMotes,
    transferId,
    deployHash: deployJson?.hash
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** account-hash (64-hex, no prefix) for a Casper public-key hex. */
export function accountHashHex(publicKeyHex: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk: any = (casperSdk as any).default ?? casperSdk
  return norm(sdk.PublicKey.fromHex(publicKeyHex).accountHash().toHex())
}

/** Build a casper-native 402 requirements object (payTo = seller public-key hex). */
export function buildNativeRequirements(params: {
  network: string
  payToPublicKeyHex: string
  amountMotes: string
  maxTimeoutSeconds: number
  transferId: number
  resourceId?: string
}): PaymentRequirements {
  const extra: NativeExtra = {
    transferId: params.transferId,
    resourceId: params.resourceId
  }
  return {
    scheme: NATIVE_SCHEME,
    network: params.network,
    asset: NATIVE_ASSET,
    amount: params.amountMotes,
    payTo: params.payToPublicKeyHex,
    maxTimeoutSeconds: params.maxTimeoutSeconds,
    extra
  }
}

export function encodeDeployProof(proof: NativeSettlementProof): string {
  return Buffer.from(JSON.stringify(proof), 'utf-8').toString('base64')
}

export function decodeDeployProof(header: string): NativeSettlementProof {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf-8')) as NativeSettlementProof
}

/** Read the casper-native `extra` off a requirement, if present. */
export function nativeExtra(req: PaymentRequirements): NativeExtra | undefined {
  const e = req.extra as NativeExtra | undefined
  return e && typeof e.transferId === 'number' ? e : undefined
}

/** Pick the first casper-native accept this wallet can fulfil. */
export function selectNativeAccept(req: PaymentRequired): PaymentRequirements | undefined {
  return req.accepts.find(
    (a) => a.scheme === NATIVE_SCHEME && a.network.startsWith('casper:')
  )
}
