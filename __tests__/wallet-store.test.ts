import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const WALLET_DIR = path.join(os.homedir(), '.midos')
const WALLET_PATH = path.join(WALLET_DIR, 'wallet.json')

vi.mock('node:fs')

const { loadWalletConfig, saveWalletConfig, getWalletPath } =
  await import('../src/wallet-store.js')

describe('wallet-store', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getWalletPath', () => {
    it('returns ~/.midos/wallet.json', () => {
      expect(getWalletPath()).toBe(WALLET_PATH)
    })
  })

  describe('loadWalletConfig', () => {
    it('returns null when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT')
      })
      expect(loadWalletConfig()).toBeNull()
    })

    it('returns parsed config when file exists', () => {
      const config = { casperSecretKey: 'abc123', network: 'casper-test' }
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config))
      expect(loadWalletConfig()).toEqual(config)
    })

    it('returns null on invalid JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('not json')
      expect(loadWalletConfig()).toBeNull()
    })
  })

  describe('saveWalletConfig', () => {
    it('creates directory and writes file with correct permissions', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT')
      })
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined)
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined)

      saveWalletConfig({ casperSecretKey: 'deadbeef', network: 'casper-test' })

      expect(fs.mkdirSync).toHaveBeenCalledWith(WALLET_DIR, {
        recursive: true,
        mode: 0o700
      })
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        WALLET_PATH,
        expect.stringContaining('deadbeef'),
        { mode: 0o600 }
      )
    })

    it('merges with existing config', () => {
      const existing = { casperSecretKey: 'old', network: 'casper' }
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(existing))
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined)
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined)

      saveWalletConfig({ network: 'casper-test' })

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      const parsed = JSON.parse(written)
      expect(parsed.casperSecretKey).toBe('old')
      expect(parsed.network).toBe('casper-test')
    })
  })
})
