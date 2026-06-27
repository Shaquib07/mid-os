/**
 * Pulse — a pay-per-call data API on Casper x402.
 *
 * Real, useful data behind an HTTP 402 paywall: agents pay per request with a
 * native CSPR transfer (verified on-chain by the facilitator) and get live data
 * back. No API keys, no subscriptions — pay only for the calls you make.
 *
 *   GET /                → free catalog of endpoints + prices
 *   GET /v1/weather      → live weather for a city          (paid)
 *   GET /v1/markets      → live crypto market data          (paid)
 *
 * Native CSPR transfers have a ~2.5 CSPR floor, so prices are >= 2_500_000_000 motes.
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { Context } from 'hono'
import dns from 'node:dns'
import {
  encodeJsonHeader,
  buildNativeRequirements,
  decodeDeployProof,
  NATIVE_SCHEME,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_DEPLOY,
  HEADER_PAYMENT_RESPONSE,
  type PaymentRequired,
  type PaymentRequirements,
  type SettleResponse
} from 'x402-casper-core'

// Prefer IPv4 — broken-IPv6 networks make Node's fetch "fetch failed" even when
// curl works (curl falls back to IPv4). Must run before any outbound fetch.
dns.setDefaultResultOrder('ipv4first')

const PORT = Number(process.env.PORT ?? '3002')
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? 'http://127.0.0.1:3001'
const X402_NETWORK = process.env.X402_NETWORK ?? 'casper:casper-test'
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${PORT}`
const CASPER_NODE_URL = process.env.CASPER_NODE_URL ?? 'https://node.testnet.casper.network/rpc'

// The account that receives payment. Must differ from the payer (a native
// transfer to yourself fails with "Invalid purse"). Override with PAY_TO.
const SELLER = '01ab039a6d9f8ed054d9590f6a29e31974323c17e3cf4c8bb3df6d96a26f5a6195'
const PAY_TO = (process.env.PAY_TO || SELLER).trim()
if (!/^0(1[0-9a-fA-F]{64}|2[0-9a-fA-F]{66})$/.test(PAY_TO)) {
  console.error('[pulse] PAY_TO must be a Casper PUBLIC KEY hex (01.. or 02..).')
  process.exit(1)
}

// Per-endpoint price in motes (1 CSPR = 1e9). 2.5 CSPR is the HARD floor — the
// Casper native-transfer minimum (anything lower is rejected as Invalid Deploy).
// Sub-2.5 micropayments require the CEP-18 token scheme, not native CSPR.
const PRICE = {
  network: process.env.PRICE_NETWORK ?? '2500000000', // 2.5 CSPR
  weather: process.env.PRICE_WEATHER ?? '2500000000', // 2.5 CSPR
  markets: process.env.PRICE_MARKETS ?? '2500000000' // 2.5 CSPR
}

const url = (p: string) => new URL(p, PUBLIC_BASE_URL).toString()

function requirements(priceMotes: string, resourceUrl: string): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: resourceUrl, mimeType: 'application/json' },
    accepts: [
      buildNativeRequirements({
        network: X402_NETWORK,
        payToPublicKeyHex: PAY_TO,
        amountMotes: priceMotes,
        maxTimeoutSeconds: 300,
        transferId: Math.floor(Math.random() * 1_000_000_000),
        resourceId: resourceUrl
      })
    ]
  }
}

function accepts(req: PaymentRequirements, priceMotes: string): string | undefined {
  if (req.scheme !== NATIVE_SCHEME) return 'wrong scheme'
  if (req.network !== X402_NETWORK) return 'wrong network'
  if (req.payTo.toLowerCase() !== PAY_TO.toLowerCase()) return 'wrong payTo'
  try {
    if (BigInt(req.amount) < BigInt(priceMotes)) return 'amount below price'
  } catch {
    return 'unparseable amount'
  }
  return undefined
}

type GateResult =
  | { ok: false; response: Response }
  | { ok: true; settle: SettleResponse }

/** x402 gate: returns a 402 until a valid, on-chain-verified payment arrives. */
async function gate(c: Context, priceMotes: string, resourceUrl: string): Promise<GateResult> {
  const proofHeader = c.req.header(HEADER_PAYMENT_DEPLOY)
  if (!proofHeader) {
    c.header(HEADER_PAYMENT_REQUIRED, encodeJsonHeader(requirements(priceMotes, resourceUrl)))
    return {
      ok: false,
      response: c.json(
        { error: 'Payment required', scheme: NATIVE_SCHEME, priceMotes, priceCspr: motesToCspr(priceMotes) },
        402
      )
    }
  }

  let proof
  try {
    proof = decodeDeployProof(proofHeader)
  } catch {
    return { ok: false, response: c.json({ error: 'Cannot decode Payment-Deploy header' }, 400) }
  }

  const policyError = accepts(proof.accepted, priceMotes)
  if (policyError) {
    return { ok: false, response: c.json({ error: `Rejected payment: ${policyError}` }, 402) }
  }

  let settle: SettleResponse
  try {
    const resp = await fetch(`${FACILITATOR_URL}/settle-native`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deployHash: proof.deployHash, payer: proof.payer, requirements: proof.accepted })
    })
    settle = (await resp.json()) as SettleResponse
  } catch (err) {
    return {
      ok: false,
      response: c.json(
        { error: `Settlement service unreachable: ${err instanceof Error ? err.message : String(err)}` },
        502
      )
    }
  }
  if (!settle.success) {
    return { ok: false, response: c.json({ error: `Payment failed: ${settle.errorReason ?? 'unknown'}` }, 402) }
  }

  c.header(HEADER_PAYMENT_RESPONSE, encodeJsonHeader(settle))
  return { ok: true, settle }
}

const motesToCspr = (m: string) => (Number(BigInt(m)) / 1e9).toFixed(3) + ' CSPR'

function receipt(settle: SettleResponse) {
  return {
    paidBy: settle.payer,
    deployHash: settle.transaction,
    explorerUrl: `https://testnet.cspr.live/deploy/${settle.transaction}`,
    network: X402_NETWORK
  }
}

// ── Upstream data sources (real, no API key) ─────────────────────────────────

/** Fetch JSON with a timeout and a few retries — upstream flakiness must not
 *  burn a payment, so we try hard before giving up. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchJson(url: string, retries = 3, timeoutMs = 6000): Promise<any> {
  let lastErr: unknown
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': 'pulse-x402/1.0', accept: 'application/json' }
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.json()
    } catch (e) {
      lastErr = e
      if (i < retries - 1) await new Promise((res) => setTimeout(res, 400 * (i + 1)))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

const WEATHER_CODES: Record<number, string> = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Depositing rime fog', 51: 'Light drizzle', 53: 'Drizzle',
  55: 'Dense drizzle', 61: 'Slight rain', 63: 'Rain', 65: 'Heavy rain',
  71: 'Slight snow', 73: 'Snow', 75: 'Heavy snow', 80: 'Rain showers',
  81: 'Rain showers', 82: 'Violent rain showers', 95: 'Thunderstorm',
  96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail'
}

/** Fallback coordinates so common cities work even if the geocoding API is down. */
const CITY_COORDS: Record<string, { name: string; country: string; latitude: number; longitude: number }> = {
  tokyo: { name: 'Tokyo', country: 'Japan', latitude: 35.6895, longitude: 139.6917 },
  london: { name: 'London', country: 'United Kingdom', latitude: 51.5074, longitude: -0.1278 },
  'new york': { name: 'New York', country: 'United States', latitude: 40.7128, longitude: -74.006 },
  'san francisco': { name: 'San Francisco', country: 'United States', latitude: 37.7749, longitude: -122.4194 },
  paris: { name: 'Paris', country: 'France', latitude: 48.8566, longitude: 2.3522 },
  berlin: { name: 'Berlin', country: 'Germany', latitude: 52.52, longitude: 13.405 },
  singapore: { name: 'Singapore', country: 'Singapore', latitude: 1.3521, longitude: 103.8198 },
  dubai: { name: 'Dubai', country: 'UAE', latitude: 25.2048, longitude: 55.2708 },
  mumbai: { name: 'Mumbai', country: 'India', latitude: 19.076, longitude: 72.8777 },
  delhi: { name: 'Delhi', country: 'India', latitude: 28.6139, longitude: 77.209 },
  bangalore: { name: 'Bangalore', country: 'India', latitude: 12.9716, longitude: 77.5946 },
  sydney: { name: 'Sydney', country: 'Australia', latitude: -33.8688, longitude: 151.2093 }
}

async function fetchWeather(city: string) {
  let place: { name: string; country: string; latitude: number; longitude: number } | undefined
  try {
    const geo = await fetchJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`
    )
    const r = geo?.results?.[0]
    if (r) place = { name: r.name, country: r.country, latitude: r.latitude, longitude: r.longitude }
  } catch {
    /* fall back to the built-in table */
  }
  if (!place) place = CITY_COORDS[city.trim().toLowerCase()]
  if (!place) throw new Error(`Unknown city "${city}" (and geocoding is unavailable)`)

  const wx = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code`
  )
  const cur = wx.current
  return {
    location: `${place.name}, ${place.country}`,
    coordinates: { lat: place.latitude, lon: place.longitude },
    observedAt: cur.time,
    conditions: WEATHER_CODES[cur.weather_code] ?? `code ${cur.weather_code}`,
    temperatureC: cur.temperature_2m,
    feelsLikeC: cur.apparent_temperature,
    humidityPct: cur.relative_humidity_2m,
    windKph: cur.wind_speed_10m,
    source: 'open-meteo.com'
  }
}

/** Casper JSON-RPC call with timeout + retries (the node is reliably reachable). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rpcCall(method: string, params: unknown[] = []): Promise<any> {
  let lastErr: unknown
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(CASPER_NODE_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j: any = await r.json()
      if (j.error) throw new Error(j.error.message ?? 'rpc error')
      return j.result
    } catch (e) {
      lastErr = e
      if (i < 2) await new Promise((res) => setTimeout(res, 400 * (i + 1)))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** Live Casper testnet network data — straight from the node. */
async function fetchNetwork() {
  const s = await rpcCall('info_get_status')
  const b = s.last_added_block_info ?? {}
  return {
    network: s.chainspec_name,
    apiVersion: s.api_version,
    build: s.build_version,
    peers: Array.isArray(s.peers) ? s.peers.length : undefined,
    reactorState: s.reactor_state,
    latestBlock: { height: b.height, hash: b.hash, era: b.era_id, timestamp: b.timestamp },
    uptime: s.uptime,
    source: 'Casper testnet node'
  }
}

async function fetchMarkets() {
  const ids = 'casper-network,bitcoin,ethereum'
  const data = await fetchJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}` +
      `&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`
  )
  const fmt = (k: string, sym: string) => ({
    symbol: sym,
    priceUsd: data[k]?.usd,
    change24hPct: data[k]?.usd_24h_change != null ? Number(data[k].usd_24h_change.toFixed(2)) : null,
    volume24hUsd: data[k]?.usd_24h_vol != null ? Math.round(data[k].usd_24h_vol) : null,
    marketCapUsd: data[k]?.usd_market_cap != null ? Math.round(data[k].usd_market_cap) : null
  })
  return {
    asOf: new Date().toISOString(),
    assets: [fmt('casper-network', 'CSPR'), fmt('bitcoin', 'BTC'), fmt('ethereum', 'ETH')],
    source: 'coingecko.com'
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

const app = new Hono()

app.get('/', (c) =>
  c.json({
    service: 'Pulse',
    description: 'Pay-per-call data API on Casper x402. No API key — pay per request.',
    network: X402_NETWORK,
    payment: { scheme: NATIVE_SCHEME, settlement: 'on-chain (native CSPR, verified)' },
    endpoints: [
      {
        path: '/v1/network',
        method: 'GET',
        description: 'Live Casper testnet status — block height, era, peers (from the node)',
        price: motesToCspr(PRICE.network),
        example: url('/v1/network')
      },
      {
        path: '/v1/weather',
        method: 'GET',
        description: 'Live weather for any city — temperature, conditions, humidity, wind',
        params: { city: 'string (e.g. Tokyo)' },
        price: motesToCspr(PRICE.weather),
        example: url('/v1/weather?city=Tokyo')
      },
      {
        path: '/v1/markets',
        method: 'GET',
        description: 'Live CSPR / BTC / ETH prices, 24h change & volume',
        price: motesToCspr(PRICE.markets),
        example: url('/v1/markets')
      }
    ]
  })
)

app.get('/v1/network', async (c) => {
  const g = await gate(c, PRICE.network, url('/v1/network'))
  if (!g.ok) return g.response
  try {
    const data = await fetchNetwork()
    return c.json({ ...data, _payment: receipt(g.settle) })
  } catch (e) {
    return c.json(
      { error: `Node query error: ${e instanceof Error ? e.message : String(e)}`, _payment: receipt(g.settle) },
      502
    )
  }
})

app.get('/v1/weather', async (c) => {
  const city = c.req.query('city') ?? 'San Francisco'
  const g = await gate(c, PRICE.weather, url('/v1/weather'))
  if (!g.ok) return g.response
  try {
    const data = await fetchWeather(city)
    return c.json({ ...data, _payment: receipt(g.settle) })
  } catch (e) {
    return c.json(
      { error: `Upstream data error: ${e instanceof Error ? e.message : String(e)}`, _payment: receipt(g.settle) },
      502
    )
  }
})

app.get('/v1/markets', async (c) => {
  const g = await gate(c, PRICE.markets, url('/v1/markets'))
  if (!g.ok) return g.response
  try {
    const data = await fetchMarkets()
    return c.json({ ...data, _payment: receipt(g.settle) })
  } catch (e) {
    return c.json(
      { error: `Upstream data error: ${e instanceof Error ? e.message : String(e)}`, _payment: receipt(g.settle) },
      502
    )
  }
})

serve({ fetch: app.fetch, port: PORT })
console.log(`Pulse data API on ${PUBLIC_BASE_URL} [${X402_NETWORK}] → seller ${PAY_TO.slice(0, 12)}…`)
console.log(`  GET /v1/network  ${motesToCspr(PRICE.network)}`)
console.log(`  GET /v1/weather  ${motesToCspr(PRICE.weather)}`)
console.log(`  GET /v1/markets  ${motesToCspr(PRICE.markets)}`)
console.log(`Settlement: ${FACILITATOR_URL}`)

// Probe data sources on boot so you know BEFORE charging whether data will flow.
void (async () => {
  // Casper node (/v1/network) — reliably reachable since the wallet uses it.
  try {
    await rpcCall('info_get_status')
    console.log('  source casper-node (network): reachable ✓')
  } catch (e) {
    console.log(`  source casper-node (network): UNREACHABLE ✗ — ${e instanceof Error ? e.message : String(e)}`)
  }
  const probes: [string, string][] = [
    ['open-meteo (weather)', 'https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current=temperature_2m'],
    ['coingecko (markets)', 'https://api.coingecko.com/api/v3/ping']
  ]
  for (const [name, u] of probes) {
    try {
      await fetchJson(u, 1, 5000)
      console.log(`  source ${name}: reachable ✓`)
    } catch (e) {
      console.log(`  source ${name}: UNREACHABLE ✗ — ${e instanceof Error ? e.message : String(e)}`)
    }
  }
})()
