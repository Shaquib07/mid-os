import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppConfig } from '@/types.js'
import type { SpendingTracker } from '@/spending.js'
import {
  loadPrivateKey,
  getX402Domain,
  recipientToPayToHex,
  decimalToAtomic
} from '@/clients.js'
import {
  buildAndSignAuthorization,
  buildPaymentSignatureHeader,
  HEADER_PAYMENT_SIGNATURE,
  type PaymentRequirements
} from 'x402-casper-core'

export function registerPay(
  server: McpServer,
  config: AppConfig,
  spending: SpendingTracker
): void {
  server.tool(
    'pay',
    'Sign a Casper x402 payment authorization (EIP-712 TransferWithAuthorization, Ed25519). ' +
      'Returns the base64 Payment-Signature header value to attach to your HTTP request. ' +
      'Use x402_fetch for the full automatic 402 flow.',
    {
      amount: z
        .string()
        .describe(
          `Amount in whole ${config.tokenSymbol} as a decimal string, e.g. "0.05"`
        ),
      recipient: z
        .string()
        .describe(
          'Recipient: a Casper public key hex, "account-hash-<hex>", or 33-byte hex'
        ),
      resource: z
        .string()
        .optional()
        .describe('URL of the resource being paid for')
    },
    async ({ amount, recipient, resource }) => {
      if (!config.canPay) {
        return errText('No wallet configured. Set CASPER_SECRET_KEY.')
      }

      try {
        spending.check(amount)

        const requirements: PaymentRequirements = {
          scheme: 'exact',
          network: config.x402Network,
          asset: config.tokenContractHash,
          amount: decimalToAtomic(amount, config.tokenDecimals),
          payTo: recipientToPayToHex(recipient),
          maxTimeoutSeconds: 300
        }

        const privateKey = await loadPrivateKey(config)
        const domain = getX402Domain(config)
        const authorization = buildAndSignAuthorization({
          privateKey,
          requirements,
          domain
        })

        const { header } = buildPaymentSignatureHeader({
          x402Version: 2,
          accepted: requirements,
          authorization,
          resource: resource ? { url: resource } : undefined
        })

        spending.record(amount, recipient, config.network)

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  headerName: HEADER_PAYMENT_SIGNATURE,
                  paymentHeader: header,
                  amount: `${amount} ${config.tokenSymbol}`,
                  amountAtomic: requirements.amount,
                  recipient,
                  network: config.x402Network,
                  resource: resource ?? null,
                  hint: `Set this as the ${HEADER_PAYMENT_SIGNATURE} header in your HTTP request.`
                },
                null,
                2
              )
            }
          ]
        }
      } catch (err) {
        return errText(
          `Payment failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  )
}

function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true }
}
