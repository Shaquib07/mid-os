/**
 * search_bazaar tool — discover x402-gated services the agent can pay for.
 *
 * Reads one or more x402 service catalogs (the free `/` index each x402 server
 * exposes) and returns the matching, directly-callable endpoints — so the agent
 * can turn a plain request ("get me Casper network data") into the right URL and
 * pay for it with `x402_fetch`, without the user supplying the URL.
 *
 * Catalogs come from `X402_BAZAAR_URLS` (comma-separated), defaulting to the
 * local Pulse data API.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const DEFAULT_CATALOGS = 'http://127.0.0.1:3002'

interface Service {
  catalog: string
  name: string
  method: string
  url: string
  price: string
  params?: Record<string, string>
}

function catalogUrls(): string[] {
  return (process.env.X402_BAZAAR_URLS ?? DEFAULT_CATALOGS)
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

/** Fetch and parse one x402 catalog (the server's `/` index). */
async function fetchCatalog(base: string): Promise<Service[]> {
  const res = await fetch(base + '/', {
    signal: AbortSignal.timeout(6000),
    headers: { accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json()
  const eps = Array.isArray(data?.endpoints) ? data.endpoints : []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return eps.map((e: any) => ({
    catalog: data?.service ?? base,
    name: e.description ?? e.path ?? 'service',
    method: e.method ?? 'GET',
    url: e.example ?? base + (e.path ?? ''),
    price: e.price ?? 'unknown',
    params: e.params
  }))
}

export function registerBazaarSearch(server: McpServer): void {
  server.tool(
    'search_bazaar',
    'Discover x402-gated data and API services the agent can autonomously pay for. ' +
      'Returns directly-callable endpoint URLs with their prices (e.g. live Casper network status, ' +
      'weather, crypto market data). Use this FIRST when the user asks for data but does not give a URL — ' +
      'pick the best match, then call x402_fetch on its `url` to pay and fetch.',
    {
      query: z
        .string()
        .optional()
        .describe('Optional keyword to filter services (e.g. "weather", "casper", "price", "network")')
    },
    async ({ query }) => {
      const bases = catalogUrls()
      const all: Service[] = []
      const failures: string[] = []

      await Promise.all(
        bases.map(async (base) => {
          try {
            all.push(...(await fetchCatalog(base)))
          } catch (e) {
            failures.push(`${base} (${e instanceof Error ? e.message : String(e)})`)
          }
        })
      )

      const matched = query
        ? all.filter((s) =>
            JSON.stringify(s).toLowerCase().includes(query.toLowerCase())
          )
        : all

      if (matched.length === 0) {
        const why = all.length === 0 && failures.length
          ? ` No catalogs reachable: ${failures.join('; ')}.`
          : query
            ? ` Nothing matched "${query}".`
            : ''
        return {
          content: [
            {
              type: 'text' as const,
              text: `No x402 services found.${why}`
            }
          ]
        }
      }

      const list = matched
        .map((s, i) => {
          const params = s.params
            ? `  (params: ${Object.keys(s.params).join(', ')})`
            : ''
          return `${i + 1}. ${s.name} — ${s.price}\n   ${s.method} ${s.url}${params}`
        })
        .join('\n\n')

      const note =
        '\n\nTo use one, call x402_fetch with its url. Payment settles automatically ' +
        'on Casper within your configured budget — no extra confirmation needed.'
      const warn = failures.length ? `\n\n(Some catalogs were unreachable: ${failures.join('; ')})` : ''

      return {
        content: [
          {
            type: 'text' as const,
            text: `Found ${matched.length} x402 service(s) you can pay for:\n\n${list}${note}${warn}`
          }
        ]
      }
    }
  )
}
