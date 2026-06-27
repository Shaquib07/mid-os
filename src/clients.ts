import fs from 'node:fs'
// casper-js-sdk is CommonJS; use default-import interop (namespace access) so
// the built ESM bundle works under Node's native ESM loader.
import casperSdk from 'casper-js-sdk'
import type { PrivateKey, PublicKey, RpcClient } from 'casper-js-sdk'
import {
  resolveDomain,
  parseCasperAddress,
  casperAccountFromBytes,
  bytesToHex,
  normalizeDeployResult,
  type DomainSeparator,
  type DeployView
} from 'x402-casper-core'
import type { AppConfig } from '@/types.js'

// ─── Key loading (Ed25519 or secp256k1, self-custody) ────────────────────────

let cachedKey: { secret: string; key: PrivateKey } | null = null

/** Parse a key, trying both Casper algorithms. Casper natively supports Ed25519
 *  and secp256k1; the rest of the wallet is algorithm-agnostic (signatures carry
 *  the algorithm tag), so we only need to pick the right one when loading. */
async function parseEitherAlg(
  load: (alg: number) => PrivateKey | Promise<PrivateKey>,
  preferSecp: boolean
): Promise<PrivateKey> {
  const order = preferSecp
    ? [casperSdk.KeyAlgorithm.SECP256K1, casperSdk.KeyAlgorithm.ED25519]
    : [casperSdk.KeyAlgorithm.ED25519, casperSdk.KeyAlgorithm.SECP256K1]
  let lastErr: unknown
  for (const alg of order) {
    try {
      return await load(alg)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

/** Load the wallet's private key (Ed25519 or secp256k1) from hex, PEM contents,
 *  or a path to a `.pem`. */
export async function loadPrivateKey(config: AppConfig): Promise<PrivateKey> {
  if (!config.casperSecretKey) {
    throw new Error('No Casper key configured. Set CASPER_SECRET_KEY.')
  }
  if (cachedKey && cachedKey.secret === config.casperSecretKey) {
    return cachedKey.key
  }

  const raw = config.casperSecretKey.trim()
  const isPemContents = raw.includes('BEGIN') && raw.includes('PRIVATE KEY')
  const isPemPath = raw.endsWith('.pem') && fs.existsSync(raw)
  const pem = isPemContents ? raw : isPemPath ? fs.readFileSync(raw, 'utf-8') : null

  let key: PrivateKey
  if (pem) {
    // "EC PRIVATE KEY" (SEC1) → secp256k1; "PRIVATE KEY" (PKCS#8) → usually Ed25519.
    const preferSecp = pem.includes('EC PRIVATE KEY')
    key = await parseEitherAlg((alg) => casperSdk.PrivateKey.fromPem(pem, alg), preferSecp)
  } else {
    key = await parseEitherAlg((alg) => casperSdk.PrivateKey.fromHex(raw, alg), false)
  }

  cachedKey = { secret: config.casperSecretKey, key }
  return key
}

export async function getPublicKey(config: AppConfig): Promise<PublicKey> {
  return (await loadPrivateKey(config)).publicKey
}

/** Public key hex — the wallet's primary address representation. */
export async function getWalletAddress(config: AppConfig): Promise<string> {
  return (await getPublicKey(config)).toHex()
}

/** "account-hash-<hex>" form, used as x402 `payTo` / on-chain account id. */
export async function getAccountHashString(config: AppConfig): Promise<string> {
  return (await getPublicKey(config)).accountHash().toPrefixedString()
}

// ─── RPC ──────────────────────────────────────────────────────────────────────

export function getRpcClient(config: AppConfig): RpcClient {
  return new casperSdk.RpcClient(new casperSdk.HttpHandler(config.nodeUrl))
}

/** Native CSPR balance in motes (1 CSPR = 1e9 motes). Returns 0n if unfunded. */
export async function getCsprBalanceMotes(config: AppConfig): Promise<bigint> {
  const rpc = getRpcClient(config)
  const pk = await getPublicKey(config)
  try {
    const res = await rpc.queryLatestBalance(
      casperSdk.PurseIdentifier.fromPublicKey(pk)
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bal = res.balance as any
    if (bal && typeof bal.toString === 'function') return BigInt(bal.toString())
    return 0n
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // A never-funded account has no main purse yet → treat as a genuine zero.
    if (/purse|not found|does not exist|unknownaccount|no such|missing/i.test(msg)) {
      return 0n
    }
    // Anything else (RPC down, bad node URL, API mismatch) must NOT masquerade
    // as an empty wallet — surface it so the cause is visible.
    throw new Error(`balance query failed (${config.network}): ${msg}`)
  }
}

// ─── x402 domain ───────────────────────────────────────────────────────────────

/** EIP-712 domain separator for this wallet's network + token. */
export function getX402Domain(config: AppConfig): DomainSeparator {
  return resolveDomain({
    name: config.tokenName,
    chainName: config.x402Network,
    contractPackageHash: config.tokenContractHash
  })
}

/**
 * Resolve a recipient string to the `payTo` hex (33-byte tagged account-hash
 * address) used in x402 requirements. Accepts an Ed25519/secp256k1 public-key
 * hex, an "account-hash-<hex>", or bare 32/33-byte hex.
 */
export function recipientToPayToHex(recipient: string): string {
  const r = recipient.trim()
  if (/^0(1[0-9a-fA-F]{64}|2[0-9a-fA-F]{66})$/.test(r)) {
    const pk = casperSdk.PublicKey.fromHex(r)
    return bytesToHex(casperAccountFromBytes(pk.accountHash().toBytes()))
  }
  return bytesToHex(parseCasperAddress(r))
}

// ─── Atomic-unit helpers ────────────────────────────────────────────────────

/** Atomic (integer string) → whole-token decimal string. */
export function atomicToDecimal(
  atomic: string | bigint,
  decimals: number
): string {
  const raw = BigInt(atomic)
  const base = 10n ** BigInt(decimals)
  const whole = raw / base
  const frac = raw % base
  return `${whole}.${frac.toString().padStart(decimals, '0')}`
}

/** Whole-token decimal string → atomic (integer string). */
export function decimalToAtomic(decimal: string, decimals: number): string {
  const [whole, frac = ''] = decimal.split('.')
  const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals)
  return (
    BigInt(whole || '0') * 10n ** BigInt(decimals) +
    BigInt(fracPadded || '0')
  ).toString()
}

// ─── Deploy verification (REAL on-chain native x402 settlement) ──────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Query a transfer deploy from the node and normalize it into a `DeployView`
 * (+ an `executed` flag for the waiter). Normalization lives in x402-casper-core
 * so the wallet and the facilitator interpret deploys identically.
 */
export async function getDeployView(
  config: AppConfig,
  deployHash: string
): Promise<DeployView & { executed: boolean }> {
  const rpc = getRpcClient(config)
  try {
    const res = await rpc.getDeploy(deployHash)
    return { ...normalizeDeployResult(res), deployHash }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/not found|nosuchdeploy|-32000|unknown deploy/i.test(msg)) {
      return { found: false, success: false, executed: false, deployHash, errorMessage: msg }
    }
    throw new Error(`getDeploy failed (${config.network}): ${msg}`)
  }
}

/** Poll until the deploy has executed (success or failure) or we time out. */
export async function waitForDeployFinalized(
  config: AppConfig,
  deployHash: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<DeployView> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  const intervalMs = opts.intervalMs ?? 5_000
  const deadline = Date.now() + timeoutMs
  await sleep(3_000) // let the deploy gossip before the first lookup
  let last: DeployView | undefined
  while (Date.now() < deadline) {
    const view = await getDeployView(config, deployHash)
    last = view
    if (view.found && view.executed) return view
    await sleep(intervalMs)
  }
  return (
    last ?? {
      found: false,
      success: false,
      deployHash,
      errorMessage: 'timed out waiting for finalization'
    }
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */
