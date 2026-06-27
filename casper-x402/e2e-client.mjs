/**
 * End-to-end check: drives the MidOS MCP server (built dist/index.js) over
 * stdio, lists tools, and calls x402_fetch against the Pulse data API — paying
 * for a live endpoint on Casper testnet and verifying the on-chain settlement.
 *
 * Usage: CASPER_SECRET_KEY=<key> RESOURCE_URL=<url> node e2e-client.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resourceUrl = process.env.RESOURCE_URL ?? 'http://127.0.0.1:3002/v1/weather?city=Tokyo'

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.join(repoRoot, 'dist/index.js')],
  cwd: repoRoot,
  env: {
    ...process.env,
    NETWORK: process.env.NETWORK ?? 'casper-test',
    CASPER_SECRET_KEY: process.env.CASPER_SECRET_KEY
  }
})

const client = new Client({ name: 'midos-e2e', version: '1.0.0' }, { capabilities: {} })
await client.connect(transport)

const tools = await client.listTools()
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '))

const res = await client.callTool({
  name: 'x402_fetch',
  arguments: { url: resourceUrl }
})
const text = res.content?.[0]?.text ?? JSON.stringify(res)
console.log('X402_FETCH RESULT:')
console.log(text)

await client.close()

// Surface a clear pass/fail for the harness. The tool returns a plain error
// string (not JSON) when something goes wrong — handle that gracefully.
let parsed
try {
  parsed = JSON.parse(text)
} catch {
  console.log('\n❌ E2E FAIL — tool returned an error (not JSON):')
  console.log('   ' + text)
  process.exit(1)
}
if (parsed.status === 200 && parsed.payment) {
  const onchain = parsed.payment.deployHash
  console.log('\n✅ E2E PASS — paid 402, got 200 with payload')
  if (onchain) {
    console.log(`   on-chain deploy: ${onchain}`)
    console.log(`   explorer: ${parsed.payment.explorerUrl ?? `https://testnet.cspr.live/deploy/${onchain}`}`)
  }
  process.exit(0)
} else {
  console.log('\n❌ E2E FAIL — status ' + parsed.status)
  process.exit(1)
}
