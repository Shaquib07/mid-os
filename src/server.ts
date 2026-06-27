import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppConfig } from '@/types.js'
import { SpendingTracker } from '@/spending.js'
import { registerCheckBalance } from '@/tools/check-balance.js'
import { registerPay } from '@/tools/pay.js'
import { registerX402Fetch } from '@/tools/x402-fetch.js'
import { registerTransferCspr } from '@/tools/transfer-cspr.js'
import { registerTransferToken } from '@/tools/transfer-token.js'
import { registerRequestFunding } from '@/tools/request-funding.js'
import { registerSpendingReport } from '@/tools/spending-report.js'
import { registerBazaarSearch } from '@/tools/bazaar-search.js'

export function createMcpServer(config: AppConfig): McpServer {
  const server = new McpServer({
    name: 'midos',
    version: '0.2.0'
  })

  const spending = new SpendingTracker(config.budget, config.tokenSymbol)

  // Core wallet — Casper
  registerCheckBalance(server, config)
  registerTransferCspr(server, config, spending)
  registerTransferToken(server, config, spending)

  // x402 Payments
  registerPay(server, config, spending)
  registerX402Fetch(server, config, spending)

  // Budget & Funding
  registerSpendingReport(server, spending)
  registerRequestFunding(server, config)

  // Discovery
  registerBazaarSearch(server)

  return server
}
