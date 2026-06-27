/**
 * transfer_cspr — Send native CSPR from the agent wallet to another account.
 * Builds, signs, and submits a native transfer deploy via casper-js-sdk.
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

export function registerTransferCspr(
  server: McpServer,
  config: AppConfig,
  spending: SpendingTracker
): void {
  server.tool(
    'transfer_cspr',
    'Send native CSPR from this agent wallet to another Casper account (recipient public key hex). ' +
      'Use this to fund another wallet or pay in CSPR. Native transfers have a network minimum (~2.5 CSPR).',
    {
      to: z
        .string()
        .describe(
          "Recipient's Casper public key hex (e.g. 01abc... or 02abc...)"
        ),
      amount: z
        .string()
        .describe('Amount of CSPR to send as a decimal string, e.g. "2.5"'),
      memo: z.string().optional().describe('Optional transfer memo/id note')
    },
    async ({ to, amount, memo }) => {
      if (!config.canPay) {
        return errText('No wallet configured. Set CASPER_SECRET_KEY.')
      }

      try {
        spending.check(amount)

        const privateKey = await loadPrivateKey(config)
        const senderPublicKeyHex = await getWalletAddress(config)
        const transferAmount = decimalToAtomic(amount, 9) // motes

        const deploy = casperSdk.makeCsprTransferDeploy({
          senderPublicKeyHex,
          recipientPublicKeyHex: to,
          transferAmount,
          chainName: config.chainName,
          memo
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
          amount: `${amount} CSPR`,
          amountMotes: transferAmount,
          network: config.network,
          explorerUrl: config.explorerTxBase
            ? `${config.explorerTxBase}${deployHash}`
            : undefined,
          memo: memo ?? null
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
