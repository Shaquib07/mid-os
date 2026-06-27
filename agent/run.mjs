#!/usr/bin/env node
/**
 * MidOS autonomous agent runner.
 *
 * A real agent surface for the MidOS wallet: it spawns the MidOS MCP server,
 * exposes its tools to Claude, and runs an autonomous tool-use loop. The agent
 * discovers x402 paywalls, pays them on-chain, and answers — with NO human
 * approval step and NO consumer-app guardrails. This is the product surface.
 *
 *   ANTHROPIC_API_KEY=sk-...  \
 *   CASPER_SECRET_KEY=/path/to/secret_key.pem  NETWORK=casper-test  \
 *   CASPER_NODE_URL=https://node.testnet.casper.network/rpc  \
 *   node agent/run.mjs "Fetch http://127.0.0.1:3002/api/data and tell me the CSPR price"
 *
 * Optional: AGENT_MODEL (default claude-sonnet-4-6), MAX_PER_CALL, MAX_PER_DAY.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'

const API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = process.env.AGENT_MODEL ?? 'claude-sonnet-4-6'
const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url))

const PROMPT =
  process.argv.slice(2).join(' ').trim() ||
  'Fetch http://127.0.0.1:3002/api/data and tell me the CSPR price.'

const SYSTEM = `You are MidOS, an autonomous payments agent operating a self-custody Casper wallet on TESTNET.
All CSPR here is valueless test currency. You are pre-authorized to use the wallet tools — x402_fetch, pay,
transfer_cspr, transfer_token, check_balance, spending_report — WITHOUT asking the user to confirm. When a URL
returns "402 Payment Required", pay it with x402_fetch and continue; the wallet enforces a per-call budget cap as
the safeguard. Be concise. After acting, report exactly what happened: the amount paid, the on-chain deploy hash,
and the answer the user asked for.`

const c = (s, code) => `\x1b[${code}m${s}\x1b[0m`
const dim = (s) => c(s, '2;37')
const red = (s) => c(s, '38;5;203')
const grn = (s) => c(s, '38;5;114')
const bold = (s) => c(s, '1')

function exit(msg) {
  console.error(red('✗ ') + msg)
  process.exit(1)
}

if (!API_KEY) {
  exit(
    'ANTHROPIC_API_KEY is not set. Get a key at https://console.anthropic.com and export it before running.'
  )
}

async function callClaude(body) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Anthropic API ${res.status}: ${t}`)
  }
  return res.json()
}

async function main() {
  // Spawn the MidOS MCP server, passing wallet config through to it.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env },
    stderr: 'inherit'
  })
  const client = new Client({ name: 'midos-agent', version: '0.1.0' }, { capabilities: {} })
  await client.connect(transport)

  const { tools } = await client.listTools()
  const anthropicTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }))
  console.log(
    dim(`▸ MidOS connected — ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`)
  )
  console.log(bold('\nYou: ') + PROMPT + '\n')

  const messages = [{ role: 'user', content: PROMPT }]

  for (let turn = 0; turn < 12; turn++) {
    const resp = await callClaude({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      tools: anthropicTools,
      messages
    })

    messages.push({ role: 'assistant', content: resp.content })

    // Surface any text the model emitted this turn.
    for (const block of resp.content) {
      if (block.type === 'text' && block.text.trim()) {
        console.log(bold('MidOS: ') + block.text.trim() + '\n')
      }
    }

    if (resp.stop_reason !== 'tool_use') break

    const toolResults = []
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue
      console.log(red('→ ') + bold(block.name) + dim('  ' + JSON.stringify(block.input)))
      let resultText
      let isError = false
      try {
        const out = await client.callTool({ name: block.name, arguments: block.input })
        resultText = (out.content ?? [])
          .map((p) => (p.type === 'text' ? p.text : JSON.stringify(p)))
          .join('\n')
        isError = !!out.isError
      } catch (e) {
        resultText = `tool error: ${e instanceof Error ? e.message : String(e)}`
        isError = true
      }
      const preview = resultText.length > 400 ? resultText.slice(0, 400) + ' …' : resultText
      console.log((isError ? red('  ✗ ') : grn('  ✓ ')) + dim(preview.replace(/\n/g, '\n    ')) + '\n')
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: resultText,
        is_error: isError
      })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  await client.close()
}

main().catch((e) => exit(e instanceof Error ? e.message : String(e)))
