import { describe, it, expect } from 'vitest'
import { KeyAlgorithm, PrivateKey } from 'casper-js-sdk'
import { keccak256 } from './eip712.js'
import { bytesToHex, toUint256Be, fromBeBytes } from './bytes.js'
import {
  buildAndSignAuthorization,
  resolveDomain,
  verifyAuthorization
} from './authorization.js'
import { casperAccountFromBytes } from './address.js'
import type { PaymentRequirements } from './types.js'

// A fake CEP-18 contract package hash (32 bytes).
const CONTRACT = 'hash-' + 'ab'.repeat(32)
const DOMAIN = resolveDomain({
  name: 'Casper X402 Token',
  chainName: 'casper:casper-test',
  contractPackageHash: CONTRACT
})

describe('keccak256 known vectors (cross-checked vs casper-eip-712 Rust tests)', () => {
  it('matches the EIP712Domain reference type hash', () => {
    const hash = keccak256(
      new TextEncoder().encode(
        'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
      )
    )
    expect(bytesToHex(hash)).toBe(
      '8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f'
    )
  })

  it('matches the Permit reference type hash', () => {
    const hash = keccak256(
      new TextEncoder().encode(
        'Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'
      )
    )
    expect(bytesToHex(hash)).toBe(
      '6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9'
    )
  })
})

describe('uint256 encoding', () => {
  it('round-trips a decimal value big-endian', () => {
    const be = toUint256Be('1000000')
    expect(be.length).toBe(32)
    expect(fromBeBytes(be)).toBe(1000000n)
    // big-endian: low byte 0x40 0x42 0x0f at the tail
    expect(bytesToHex(be).endsWith('0f4240')).toBe(true)
  })
})

describe('authorization sign → verify round-trip', () => {
  async function makeKeyAndReq() {
    const sk = await PrivateKey.generate(KeyAlgorithm.ED25519)
    const payToHash = new Uint8Array(32).fill(0x11)
    const payTo = bytesToHex(casperAccountFromBytes(payToHash))
    const req: PaymentRequirements = {
      scheme: 'exact',
      network: 'casper:casper-test',
      asset: CONTRACT,
      amount: '1000000',
      payTo,
      maxTimeoutSeconds: 300
    }
    return { sk, req }
  }

  it('produces a valid authorization the verifier accepts', async () => {
    const { sk, req } = await makeKeyAndReq()
    const auth = buildAndSignAuthorization({ privateKey: sk, requirements: req, domain: DOMAIN })

    expect(auth.public_key.length).toBe(66) // 33 tagged bytes
    expect(auth.signature.length).toBe(130) // 65 tagged bytes

    const res = verifyAuthorization({ auth, requirements: req, domain: DOMAIN })
    expect(res.isValid).toBe(true)
    expect(res.payer).toMatch(/^account-hash-/)
  })

  it('rejects a tampered amount', async () => {
    const { sk, req } = await makeKeyAndReq()
    const auth = buildAndSignAuthorization({ privateKey: sk, requirements: req, domain: DOMAIN })
    const res = verifyAuthorization({
      auth,
      requirements: { ...req, amount: '2000000' },
      domain: DOMAIN
    })
    expect(res.isValid).toBe(false)
    expect(res.invalidReason).toMatch(/amount mismatch/)
  })

  it('rejects a tampered destination', async () => {
    const { sk, req } = await makeKeyAndReq()
    const auth = buildAndSignAuthorization({ privateKey: sk, requirements: req, domain: DOMAIN })
    const otherPayTo = bytesToHex(casperAccountFromBytes(new Uint8Array(32).fill(0x22)))
    const res = verifyAuthorization({
      auth,
      requirements: { ...req, payTo: otherPayTo },
      domain: DOMAIN
    })
    expect(res.isValid).toBe(false)
    expect(res.invalidReason).toMatch(/destination mismatch/)
  })

  it('rejects a signature under a different domain', async () => {
    const { sk, req } = await makeKeyAndReq()
    const auth = buildAndSignAuthorization({ privateKey: sk, requirements: req, domain: DOMAIN })
    const otherDomain = resolveDomain({
      name: 'Casper X402 Token',
      chainName: 'casper:casper', // different chain
      contractPackageHash: CONTRACT
    })
    const res = verifyAuthorization({ auth, requirements: req, domain: otherDomain })
    expect(res.isValid).toBe(false)
    expect(res.invalidReason).toMatch(/signature verification failed/)
  })
})
