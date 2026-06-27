import { describe, it, expect, beforeEach, vi } from 'vitest'
import { loadConfig } from '../src/config.js'

vi.mock('../src/wallet-store.js', () => ({
  loadWalletConfig: vi.fn(() => null)
}))

const ENV_KEYS = [
  'CASPER_SECRET_KEY',
  'NETWORK',
  'CASPER_NODE_URL',
  'X402_TOKEN_CONTRACT',
  'X402_TOKEN_NAME',
  'MAX_PER_CALL',
  'MAX_PER_DAY'
]

describe('loadConfig', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
  })

  it('is READ_ONLY when no key is set', () => {
    const config = loadConfig()
    expect(config.mode).toBe('READ_ONLY')
    expect(config.canPay).toBe(false)
  })

  it('is CASPER mode when a secret key is set', () => {
    process.env.CASPER_SECRET_KEY = 'deadbeef'
    const config = loadConfig()
    expect(config.mode).toBe('CASPER')
    expect(config.canPay).toBe(true)
  })

  it('defaults to casper-test with matching x402 network and chain name', () => {
    const config = loadConfig()
    expect(config.network).toBe('casper-test')
    expect(config.x402Network).toBe('casper:casper-test')
    expect(config.chainName).toBe('casper-test')
    expect(config.nodeUrl).toContain('testnet')
  })

  it('maps NETWORK=casper to mainnet identifiers', () => {
    process.env.NETWORK = 'casper'
    const config = loadConfig()
    expect(config.x402Network).toBe('casper:casper')
    expect(config.chainName).toBe('casper')
  })

  it('applies token + budget defaults', () => {
    const config = loadConfig()
    expect(config.tokenName).toBe('Casper X402 Token')
    expect(config.tokenSymbol).toBe('CSPR')
    expect(config.tokenDecimals).toBe(9)
    expect(config.budget.maxPerCall).toBe('1.0')
    expect(config.budget.maxPerDay).toBe('100.0')
  })

  it('honors CASPER_NODE_URL override', () => {
    process.env.CASPER_NODE_URL = 'http://localhost:11101/rpc'
    expect(loadConfig().nodeUrl).toBe('http://localhost:11101/rpc')
  })
})
