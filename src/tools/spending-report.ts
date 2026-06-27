/**
 * spending_report — Expose the SpendingTracker to the agent as an MCP tool.
 * Lets the agent reason about its own financial history and remaining budget.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SpendingTracker } from '@/spending.js'

export function registerSpendingReport(
  server: McpServer,
  spending: SpendingTracker
): void {
  server.tool(
    'spending_report',
    'Show a full breakdown of all payments this agent has made in the current session: ' +
      'how much was spent today, this session, remaining daily budget, and a history ' +
      'of all recent x402 payments and CSPR transfers. Use this to audit your own spending.',
    {},
    async () => {
      try {
        const summary = spending.getSummary()

        const dailyLimit = parseFloat(summary.limits.maxPerDay)
        const spentToday = parseFloat(summary.spentToday)
        const remaining = Math.max(0, dailyLimit - spentToday)

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  summary: {
                    spentToday: `${summary.spentToday} CSPR`,
                    spentThisSession: `${summary.spentSession} CSPR`,
                    remainingDailyBudget: `${remaining.toFixed(4)} CSPR`,
                    dailyLimit: `${summary.limits.maxPerDay} CSPR`,
                    perCallLimit: `${summary.limits.maxPerCall} CSPR`
                  },
                  recentPayments: summary.recentPayments.map(p => ({
                    recipient: p.recipient,
                    amount: `${p.amount} CSPR`,
                    network: p.network,
                    time: p.timestamp
                  })),
                  totalPayments: summary.recentPayments.length
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
