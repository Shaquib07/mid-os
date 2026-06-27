import type { AppConfig, CasperNetwork, NetworkInfo } from '@/types.js'
import { loadWalletConfig } from '@/wallet-store.js'

/** Placeholder CEP-18 contract used when X402_TOKEN_CONTRACT is unset. Both the
 * wallet and the facilitator default to this so the EIP-712 domain agrees for
 * the `exact` scheme. CEP-18 settlement requires a real deployed contract; the
 * `casper-native` scheme settles with native CSPR and needs no contract. */
const PLACEHOLDER_CONTRACT = 'hash-' + '00'.repeat(32)

const NETWORKS: Record<CasperNetwork, NetworkInfo> = {
  casper: {
    chainName: 'casper',
    x402Network: 'casper:casper',
    nodeUrl: 'https://rpc.mainnet.casperlabs.io/rpc',
    explorerTxBase: 'https://cspr.live/deploy/'
  },
  'casper-test': {
    chainName: 'casper-test',
    x402Network: 'casper:casper-test',
    nodeUrl: 'https://rpc.testnet.casperlabs.io/rpc',
    explorerTxBase: 'https://testnet.cspr.live/deploy/'
  },
  'casper-nctl': {
    chainName: 'casper-net-1',
    x402Network: 'casper:nctl',
    nodeUrl: 'http://127.0.0.1:11101/rpc',
    explorerTxBase: ''
  }
}

export function getNetworkInfo(network: CasperNetwork): NetworkInfo {
  return NETWORKS[network] ?? NETWORKS['casper-test']
}

export function loadConfig(): AppConfig {
  const state = buildState()
  return {
    ...state,
    reload() {
      Object.assign(this, buildState())
    }
  }
}

function buildState(): Omit<AppConfig, 'reload'> {
  const wallet = loadWalletConfig()

  const casperSecretKey =
    process.env.CASPER_SECRET_KEY ?? wallet?.casperSecretKey ?? undefined

  const network = (process.env.NETWORK ??
    wallet?.network ??
    'casper-test') as CasperNetwork
  const info = getNetworkInfo(network)

  const nodeUrl = process.env.CASPER_NODE_URL ?? info.nodeUrl
  const tokenContractHash =
    process.env.X402_TOKEN_CONTRACT ?? PLACEHOLDER_CONTRACT
  const tokenName = process.env.X402_TOKEN_NAME ?? 'Casper X402 Token'
  const tokenSymbol = process.env.X402_TOKEN_SYMBOL ?? 'CSPR'
  const tokenDecimals = Number(process.env.X402_TOKEN_DECIMALS ?? '9')
  const payToDefault = process.env.PAY_TO ?? undefined

  const maxPerCall = process.env.MAX_PER_CALL ?? '1.0'
  const maxPerDay = process.env.MAX_PER_DAY ?? '100.0'

  const canPay = !!casperSecretKey

  return {
    casperSecretKey,
    network,
    nodeUrl,
    chainName: info.chainName,
    x402Network: info.x402Network,
    explorerTxBase: info.explorerTxBase,
    tokenContractHash,
    tokenName,
    tokenSymbol,
    tokenDecimals,
    payToDefault,
    budget: { maxPerCall, maxPerDay },
    canPay,
    mode: canPay ? 'CASPER' : 'READ_ONLY'
  }
}
