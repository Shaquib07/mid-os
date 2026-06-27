/**
 * MidOS Casper x402 Facilitator.
 *
 * Two settlement schemes:
 *   - `exact`         → EIP-712 TransferWithAuthorization (verify only here).
 *   - `casper-native` → REAL on-chain settlement. The payer submits a native
 *                       CSPR transfer; this facilitator VERIFIES it on-chain
 *                       (finalized, correct recipient/amount/payer, no replay)
 *                       before acknowledging. No mock, no off-chain ref.
 *
 * Endpoints: GET /supported, POST /verify (exact), POST /settle-native.
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
// casper-js-sdk is CommonJS; default-import interop.
import casperSdk from 'casper-js-sdk'
import {
  resolveDomain,
  verifyAuthorization,
  normalizeDeployResult,
  verifyNativeSettlement,
  accountHashHex,
  nativeExtra,
  NATIVE_SCHEME,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyRequest,
  type VerifyResponse
} from 'x402-casper-core'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sdk: any = (casperSdk as any).default ?? casperSdk

const PORT = Number(process.env.PORT ?? '3001')
const X402_NETWORK = process.env.X402_NETWORK ?? 'casper:casper-test'
const TOKEN_NAME = process.env.X402_TOKEN_NAME ?? 'Casper X402 Token'
const TOKEN_CONTRACT = process.env.X402_TOKEN_CONTRACT ?? 'hash-' + '00'.repeat(32)
const TOKEN_DECIMALS = Number(process.env.X402_TOKEN_DECIMALS ?? '9')
const TOKEN_SYMBOL = process.env.X402_TOKEN_SYMBOL ?? 'CSPR'
const CASPER_NODE_URL = process.env.CASPER_NODE_URL ?? 'https://node.testnet.casper.network/rpc'

const domain = resolveDomain({
  name: TOKEN_NAME,
  chainName: X402_NETWORK,
  contractPackageHash: TOKEN_CONTRACT
})

const rpc = new sdk.RpcClient(new sdk.HttpHandler(CASPER_NODE_URL))

/** Replay protection — a settled deploy can only unlock a resource once. */
const consumedDeploys = new Set<string>()

const app = new Hono()

app.get('/', (c) =>
  c.json({
    service: 'midos-casper-facilitator',
    network: X402_NETWORK,
    node: CASPER_NODE_URL,
    schemes: ['exact', NATIVE_SCHEME],
    endpoints: ['GET /supported', 'POST /verify', 'POST /settle-native']
  })
)

app.get('/supported', (c) =>
  c.json({
    kinds: [
      {
        x402Version: 2,
        scheme: NATIVE_SCHEME,
        network: X402_NETWORK,
        asset: 'native-cspr',
        extra: { decimals: 9, symbol: 'CSPR', settlement: 'onchain' }
      },
      {
        x402Version: 2,
        scheme: 'exact',
        network: X402_NETWORK,
        asset: TOKEN_CONTRACT,
        extra: { decimals: TOKEN_DECIMALS, symbol: TOKEN_SYMBOL, name: TOKEN_NAME, version: '1' }
      }
    ],
    extensions: [],
    signers: { 'casper:*': [] }
  })
)

// EIP-712 `exact` verification (signature only).
app.post('/verify', async (c) => {
  const body = (await c.req.json()) as VerifyRequest
  const auth = body.paymentPayload?.payload
  if (!auth) {
    return c.json<VerifyResponse>({ isValid: false, invalidReason: 'missing payment payload' }, 400)
  }
  const result = verifyAuthorization({ auth, requirements: body.paymentRequirements, domain })
  console.log(
    result.isValid
      ? `[verify] valid — payer ${result.payer}`
      : `[verify] invalid — ${result.invalidReason}`
  )
  return c.json<VerifyResponse>(result)
})

interface NativeSettleRequest {
  deployHash: string
  payer: string
  requirements: PaymentRequirements
}

// REAL on-chain native settlement: verify the transfer deploy on Casper.
app.post('/settle-native', async (c) => {
  const body = (await c.req.json()) as NativeSettleRequest
  const { deployHash, requirements } = body

  if (!deployHash || !requirements?.payTo) {
    return c.json<SettleResponse>({ success: false, errorReason: 'missing deployHash or requirements' }, 400)
  }
  if (consumedDeploys.has(deployHash)) {
    console.log(`[settle-native] replay rejected — ${deployHash}`)
    return c.json<SettleResponse>({ success: false, errorReason: 'deploy already used (replay)' })
  }

  let payToAccountHash: string
  try {
    payToAccountHash = accountHashHex(requirements.payTo)
  } catch {
    return c.json<SettleResponse>({ success: false, errorReason: 'invalid payTo public key' })
  }
  const transferId = nativeExtra(requirements)?.transferId

  // Query the node and verify the transfer on-chain.
  let view
  try {
    const res = await rpc.getDeploy(deployHash)
    view = normalizeDeployResult(res)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.log(`[settle-native] node query failed — ${msg}`)
    return c.json<SettleResponse>({ success: false, errorReason: `node query failed: ${msg}` })
  }

  const result = verifyNativeSettlement(view, {
    payToAccountHash,
    amountMotes: requirements.amount,
    transferId
  })

  if (!result.ok) {
    console.log(`[settle-native] rejected — ${result.reason} (${deployHash})`)
    return c.json<SettleResponse>({ success: false, errorReason: result.reason, payer: view.payerPublicKey })
  }

  consumedDeploys.add(deployHash)
  console.log(
    `[settle-native] SETTLED on-chain — ${result.amountMotes} motes, payer ${result.payer}, deploy ${deployHash}`
  )
  return c.json<SettleResponse>({ success: true, transaction: deployHash, payer: result.payer })
})

serve({ fetch: app.fetch, port: PORT })
console.log(
  `MidOS facilitator on http://127.0.0.1:${PORT} [${X402_NETWORK}, on-chain native settle via ${CASPER_NODE_URL}]`
)
