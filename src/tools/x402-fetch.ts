import { z } from 'zod'
import casperSdk from 'casper-js-sdk'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppConfig } from '@/types.js'
import type { SpendingTracker } from '@/spending.js'
import {
  loadPrivateKey,
  getX402Domain,
  atomicToDecimal,
  getRpcClient,
  getWalletAddress,
  waitForDeployFinalized
} from '@/clients.js'
import {
  buildAndSignAuthorization,
  buildPaymentSignatureHeader,
  decodePaymentRequired,
  selectCasperAccept,
  selectNativeAccept,
  nativeExtra,
  encodeDeployProof,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_DEPLOY,
  type PaymentRequired,
  type NativeSettlementProof
} from 'x402-casper-core'

function isLikelyText(contentType: string | null): boolean {
  if (!contentType) return false
  const n = contentType.toLowerCase()
  return (
    n.startsWith('text/') ||
    n.includes('application/json') ||
    n.includes('application/xml') ||
    n.includes('application/javascript') ||
    n.includes('application/x-www-form-urlencoded')
  )
}

async function formatBody(response: Response) {
  const contentType = response.headers.get('content-type')
  const contentLength = response.headers.get('content-length')
  if (isLikelyText(contentType)) {
    return {
      body: await response.text(),
      bodyEncoding: 'text' as const,
      contentType,
      contentLength
    }
  }
  const buf = await response.arrayBuffer()
  return {
    body: Buffer.from(buf).toString('base64'),
    bodyEncoding: 'base64' as const,
    contentType,
    contentLength
  }
}

export function registerX402Fetch(
  server: McpServer,
  config: AppConfig,
  spending: SpendingTracker
): void {
  server.tool(
    'x402_fetch',
    'Fetch a URL, automatically paying any x402 paywall. If the endpoint returns 402 Payment Required, ' +
      'MidOS pays it with a real on-chain Casper transfer (within your configured MAX_PER_CALL / MAX_PER_DAY ' +
      'budget), waits for settlement, and returns the data. Use this to access any paid or x402-gated API. ' +
      'The budget caps are the safeguard, so you do NOT need separate confirmation before paying. If you do ' +
      'not have an exact URL for what the user wants, call search_bazaar first to discover the endpoint, then ' +
      'pass its url here.',
    {
      url: z.string().url().describe('The URL to fetch'),
      method: z
        .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
        .default('GET')
        .describe('HTTP method (default: GET)'),
      headers: z
        .record(z.string())
        .optional()
        .describe('Optional HTTP headers'),
      body: z.string().optional().describe('Optional request body')
    },
    async ({ url, method, headers, body }) => {
      if (!config.canPay) {
        return errText('No wallet configured. Set CASPER_SECRET_KEY.')
      }

      try {
        const baseOpts: RequestInit = { method, headers: headers ?? {} }
        if (body && method !== 'GET') baseOpts.body = body

        const initial = await fetch(url, baseOpts)
        if (initial.status !== 402) {
          const payload = await formatBody(initial)
          return json({
            status: initial.status,
            statusText: initial.statusText,
            ...payload
          })
        }

        // Parse the 402 requirements (header preferred, body fallback).
        let required: PaymentRequired
        const reqHeader = initial.headers.get(HEADER_PAYMENT_REQUIRED)
        if (reqHeader) {
          required = decodePaymentRequired(reqHeader)
        } else {
          required = (await initial.json()) as PaymentRequired
        }

        // ── casper-native scheme: settle by a REAL on-chain CSPR transfer ──
        const native = selectNativeAccept(required)
        if (native) {
          const amountMotes = native.amount
          const amountDecimal = atomicToDecimal(amountMotes, 9)
          spending.check(amountDecimal)

          const privateKey = await loadPrivateKey(config)
          const senderPublicKeyHex = await getWalletAddress(config)
          const extra = nativeExtra(native)

          // Submit the native transfer to the seller's public key.
          const deploy = casperSdk.makeCsprTransferDeploy({
            senderPublicKeyHex,
            recipientPublicKeyHex: native.payTo,
            transferAmount: amountMotes,
            chainName: config.chainName,
            memo: extra ? String(extra.transferId) : undefined
          })
          deploy.sign(privateKey)
          const rpc = getRpcClient(config)
          const putResult = await rpc.putDeploy(deploy)
          const deployHash: string =
            typeof putResult.deployHash === 'string'
              ? putResult.deployHash
              : putResult.deployHash.toHex()

          // Wait for on-chain finalization before presenting proof of payment.
          const view = await waitForDeployFinalized(config, deployHash)
          if (!view.found || !view.success) {
            return errText(
              `On-chain payment did not finalize: ${view.errorMessage ?? 'unknown'} (deploy ${deployHash})`
            )
          }
          spending.record(amountDecimal, native.payTo, config.network)

          const proof: NativeSettlementProof = {
            deployHash,
            payer: senderPublicKeyHex,
            accepted: native
          }
          const retryOpts: RequestInit = {
            method,
            headers: { ...(headers ?? {}), [HEADER_PAYMENT_DEPLOY]: encodeDeployProof(proof) }
          }
          if (body && method !== 'GET') retryOpts.body = body

          const paid = await fetch(url, retryOpts)
          const payload = await formatBody(paid)
          const paymentResponse = paid.headers.get(HEADER_PAYMENT_RESPONSE) ?? undefined

          return json({
            status: paid.status,
            statusText: paid.statusText,
            ...payload,
            payment: {
              settlement: 'onchain',
              amount: `${amountDecimal} CSPR`,
              amountMotes,
              recipient: native.payTo,
              network: native.network,
              deployHash,
              explorerUrl: config.explorerTxBase
                ? `${config.explorerTxBase}${deployHash}`
                : undefined,
              paymentResponse
            }
          })
        }

        const accept = selectCasperAccept(required)
        if (!accept) {
          const nets = (required.accepts ?? []).map(a => a.network).join(', ')
          return errText(
            `Cannot fulfil payment. Server accepts: [${nets}] but this wallet only pays Casper (${config.x402Network}).`
          )
        }

        const amountDecimal = atomicToDecimal(
          accept.amount,
          config.tokenDecimals
        )
        spending.check(amountDecimal)

        const privateKey = await loadPrivateKey(config)
        const domain = getX402Domain(config)
        const authorization = buildAndSignAuthorization({
          privateKey,
          requirements: accept,
          domain
        })
        const { header } = buildPaymentSignatureHeader({
          x402Version: required.x402Version ?? 2,
          accepted: accept,
          authorization,
          resource: required.resource
        })

        const retryOpts: RequestInit = {
          method,
          headers: { ...(headers ?? {}), 'Payment-Signature': header }
        }
        if (body && method !== 'GET') retryOpts.body = body

        const paid = await fetch(url, retryOpts)
        const payload = await formatBody(paid)
        spending.record(amountDecimal, accept.payTo, config.network)

        const paymentResponse =
          paid.headers.get(HEADER_PAYMENT_RESPONSE) ?? undefined

        return json({
          status: paid.status,
          statusText: paid.statusText,
          ...payload,
          payment: {
            amount: `${amountDecimal} ${config.tokenSymbol}`,
            amountAtomic: accept.amount,
            recipient: accept.payTo,
            network: accept.network,
            paymentResponse
          },
          hint:
            payload.bodyEncoding === 'base64'
              ? 'Binary response returned as base64. Decode using the reported contentType.'
              : undefined
        })
      } catch (err) {
        return errText(
          `x402 fetch failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  )
}

function json(obj: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }]
  }
}
function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true }
}
