/**
 * request_funding — Show this wallet's Casper address and a funding request so a
 * human (or another agent) can top it up with CSPR. Casper has no standard
 * payment deep-link scheme, so this returns the account details plus an explorer
 * link and (on testnet) a faucet hint.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppConfig } from '@/types.js'
import { getWalletAddress, getAccountHashString } from '@/clients.js'

export function registerRequestFunding(
  server: McpServer,
  config: AppConfig
): void {
  server.tool(
    'request_funding',
    'Generate a CSPR funding request for this agent wallet: returns the public key, account hash, ' +
      'amount, and (on testnet) a faucet hint. Use this when the wallet is low on funds.',
    {
      amount: z.string().describe('Amount of CSPR to request, e.g. "10"'),
      note: z
        .string()
        .optional()
        .describe('Optional message, e.g. "Agent needs gas for API tasks"')
    },
    async ({ amount, note }) => {
      if (!config.canPay) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No wallet configured. Set CASPER_SECRET_KEY.'
            }
          ],
          isError: true
        }
      }

      try {
        const [publicKey, accountHash] = await Promise.all([
          getWalletAddress(config),
          getAccountHashString(config)
        ])

        const isTestnet = config.network !== 'casper'
        const accountExplorer =
          config.network === 'casper'
            ? `https://cspr.live/account/${publicKey}`
            : config.network === 'casper-test'
              ? `https://testnet.cspr.live/account/${publicKey}`
              : undefined

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  message: `Please send ${amount} CSPR to fund this agent wallet.`,
                  publicKey,
                  accountHash,
                  amount: `${amount} CSPR`,
                  network: config.network,
                  accountExplorer,
                  faucet: isTestnet
                    ? 'Testnet faucet: https://testnet.cspr.live/tools/faucet'
                    : undefined,
                  note: note ?? null,
                  instructions: [
                    'Send CSPR to the publicKey above from any Casper wallet (CSPR.live, Casper Wallet).',
                    isTestnet
                      ? 'On testnet you can also use the faucet link to fund this account for free.'
                      : 'Use an exchange or another wallet to send mainnet CSPR.'
                  ]
                },
                null,
                2
              )
            }
          ]
        }
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`
            }
          ],
          isError: true
        }
      }
    }
  )
}
