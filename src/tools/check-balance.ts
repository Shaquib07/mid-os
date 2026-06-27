import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppConfig } from '@/types.js'
import {
  getWalletAddress,
  getAccountHashString,
  getCsprBalanceMotes,
  atomicToDecimal
} from '@/clients.js'

export function registerCheckBalance(
  server: McpServer,
  config: AppConfig
): void {
  server.tool(
    'check_balance',
    'Check the wallet on the configured Casper network: public key, account hash, and native CSPR balance (used for gas and x402 payments).',
    {},
    async () => {
      if (!config.canPay) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No wallet configured. Set CASPER_SECRET_KEY (Ed25519 hex or PEM).'
            }
          ],
          isError: true
        }
      }

      try {
        const [publicKey, accountHash, motes] = await Promise.all([
          getWalletAddress(config),
          getAccountHashString(config),
          getCsprBalanceMotes(config)
        ])

        const result = {
          publicKey,
          accountHash,
          network: config.network,
          mode: config.mode,
          cspr: `${atomicToDecimal(motes, 9)} CSPR`,
          tokenContract: config.tokenContractHash,
          note:
            motes === 0n
              ? 'Balance is 0 — fund this account via a faucet (testnet) or transfer CSPR to the account hash above.'
              : undefined
        }

        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(result, null, 2) }
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
