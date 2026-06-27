#!/usr/bin/env node
/**
 * verify-deploy — print the normalized on-chain view of a transfer deploy.
 *
 * Field-path safety net for the casper-native settlement: run it against a real
 * transfer hash to confirm the verifier reads `success`, `payer`, recipient
 * `toAccountHash`, `amountMotes`, and `transferId` correctly against a real tx.
 *
 *   CASPER_NODE_URL=https://node.testnet.casper.network/rpc \
 *   node scripts/verify-deploy.mjs <deployHash>
 */
import casperSdk from 'casper-js-sdk'
import { normalizeDeployResult } from 'x402-casper-core'

const sdk = casperSdk.default ?? casperSdk
const NODE = process.env.CASPER_NODE_URL ?? 'https://node.testnet.casper.network/rpc'
const hash = process.argv[2]

if (!hash) {
  console.error('usage: node scripts/verify-deploy.mjs <deployHash>')
  process.exit(1)
}

const rpc = new sdk.RpcClient(new sdk.HttpHandler(NODE))

try {
  const res = await rpc.getDeploy(hash)
  const view = normalizeDeployResult(res)
  console.log(JSON.stringify({ ...view, deployHash: hash }, null, 2))
  console.log(
    view.success
      ? '\n✓ executed successfully'
      : `\n✗ not a successful transfer: ${view.errorMessage ?? 'unknown'}`
  )
} catch (e) {
  console.error(`getDeploy failed against ${NODE}: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
