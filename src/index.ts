// ─── CRITICAL: Redirect all console output to stderr ─────────────────────────
// MCP servers communicate via stdin/stdout (JSON-RPC). Any console.log that
// reaches stdout corrupts the protocol. SDKs may log to stdout, so we redirect
// console output to stderr before anything else runs.
const _write = (msg: unknown, ...args: unknown[]) =>
  process.stderr.write(`${[msg, ...args].join(' ')}\n`)
console.log = _write
console.info = _write
console.debug = _write
// Keep console.error/warn going to stderr (already correct)

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from '@/config.js'
import { createMcpServer } from '@/server.js'

const config = loadConfig()
const server = createMcpServer(config)
const transport = new StdioServerTransport()
await server.connect(transport)
