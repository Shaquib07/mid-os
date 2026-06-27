import { describe, it, expect } from 'vitest'
import { atomicToDecimal, decimalToAtomic, recipientToPayToHex } from '../src/clients.js'

describe('atomic-unit helpers', () => {
  it('converts atomic motes to a decimal CSPR string (9 decimals)', () => {
    expect(atomicToDecimal('1000000', 9)).toBe('0.001000000')
    expect(atomicToDecimal('2500000000', 9)).toBe('2.500000000')
  })

  it('converts a decimal CSPR string back to atomic motes', () => {
    expect(decimalToAtomic('0.001', 9)).toBe('1000000')
    expect(decimalToAtomic('2.5', 9)).toBe('2500000000')
  })

  it('round-trips', () => {
    const atomic = '123456789'
    expect(decimalToAtomic(atomicToDecimal(atomic, 9), 9)).toBe(atomic)
  })
})

describe('recipientToPayToHex', () => {
  it('resolves an account-hash string to 33-byte tagged hex (tag 0x00)', () => {
    const acct = 'account-hash-' + '11'.repeat(32)
    const hex = recipientToPayToHex(acct)
    expect(hex).toBe('00' + '11'.repeat(32))
    expect(hex.length).toBe(66)
  })

  it('derives an account hash from a public key hex', () => {
    // ed25519 public key hex (tag 01 + 32 bytes)
    const pkHex = '01' + 'ab'.repeat(32)
    const hex = recipientToPayToHex(pkHex)
    expect(hex.startsWith('00')).toBe(true) // tagged account-hash address
    expect(hex.length).toBe(66)
  })
})
