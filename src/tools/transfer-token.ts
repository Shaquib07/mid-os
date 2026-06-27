/**
 * transfer_token — Send a CEP-18 token from the agent wallet to another account.
 * Builds, signs, and submits a CEP-18 transfer deploy via casper-js-sdk.
 */
import { z } from 'zod'
import casperSdk from 'casper-js-sdk'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppConfig } from '@/types.js'
import type { SpendingTracker } from '@/spending.js'
import {
  loadPrivateKey,
  getRpcClient,
  getWalletAddress,
  decimalToAtomic
} from '@/clients.js'

/** Default gas budget for a CEP-18 transfer (3 CSPR in motes). */
const DEFAULT_PAYMENT_MOTES = '3000000000'

export function registerTransferToken(
  server: McpServer,
  config: AppConfig,
  spending: SpendingTracker
): void {
  server.tool(
    'transfer_token',
    'Send a CEP-18 token (the configured x402 payment asset) from this agent wallet to another ' +
      'Casper account (recipient public key hex). This is a real on-chain CEP-18 transfer — not an x402 header.',
    {
      to: z.string().describe("Recipient's Casper public key hex"),
      amount: z
        .string()
        .describe(
          `Token amount as a decimal string (token has ${config.tokenDecimals} decimals)`
        ),
      contractPackageHash: z
        .string()
        .optional()
        .describe(
          'CEP-18 contract package hash ("hash-<hex>" or hex). Defaults to the configured token.'
        )
    },
    async ({ to, amount, contractPackageHash }) => {
      if (!config.canPay) {
        return errText('No wallet configured. Set CASPER_SECRET_KEY.')
      }

      const contract = (
        contractPackageHash ?? config.tokenContractHash
      ).replace(/^hash-/, '')
      if (/^0+$/.test(contract)) {
        return errText(
          'No real CEP-18 contract configured. Set X402_TOKEN_CONTRACT to a deployed contract package hash.'
        )
      }

      try {
        spending.check(amount)

        const privateKey = await loadPrivateKey(config)
        const senderPublicKeyHex = await getWalletAddress(config)
        const transferAmount = decimalToAtomic(amount, config.tokenDecimals)

        const deploy = await casperSdk.makeCep18TransferDeploy({
          contractPackageHash: contract,
          senderPublicKeyHex,
          recipientPublicKeyHex: to,
          transferAmount,
          paymentAmount: DEFAULT_PAYMENT_MOTES,
          chainName: config.chainName
        })
        deploy.sign(privateKey)

        const rpc = getRpcClient(config)
        const { deployHash } = await rpc.putDeploy(deploy)

        spending.record(amount, to, config.network)

        return json({
          success: true,
          deployHash,
          from: senderPublicKeyHex,
          to,
          amount: `${amount} ${config.tokenSymbol}`,
          amountAtomic: transferAmount,
          contractPackageHash: `hash-${contract}`,
          network: config.network,
          explorerUrl: config.explorerTxBase
            ? `${config.explorerTxBase}${deployHash}`
            : undefined
        })
      } catch (err) {
        return errText(
          `Transfer failed: ${err instanceof Error ? err.message : String(err)}`
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
