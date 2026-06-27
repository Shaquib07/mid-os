export type CasperNetwork = 'casper' | 'casper-test' | 'casper-nctl'

/** Static per-network settings (RPC endpoint, chain names, explorer). */
export interface NetworkInfo {
  /** On-chain deploy chain name: 'casper' | 'casper-test' | 'casper-net-1'. */
  chainName: string
  /** x402 `network` identifier used in payment requirements / domain. */
  x402Network: string
  /** Default RPC node URL (overridable via CASPER_NODE_URL). */
  nodeUrl: string
  /** Explorer deploy URL prefix, e.g. https://cspr.live/deploy/. */
  explorerTxBase: string
}

export interface AppConfig {
  /** Ed25519 secret key — raw hex, PEM contents, or a path to a .pem file. */
  casperSecretKey?: string
  network: CasperNetwork
  nodeUrl: string
  chainName: string
  x402Network: string
  explorerTxBase: string
  /** CEP-18 token contract/package hash used as the x402 `asset` ("hash-<hex>"). */
  tokenContractHash: string
  /** EIP-712 domain name for the token (default "Casper X402 Token"). */
  tokenName: string
  /** Display symbol for the payment asset (default "CSPR"). */
  tokenSymbol: string
  /** Token decimals (default 9 — same as CSPR motes). */
  tokenDecimals: number
  /** Optional default recipient for x402 payments. */
  payToDefault?: string
  budget: BudgetConfig
  canPay: boolean
  mode: 'READ_ONLY' | 'CASPER'
  reload(): void
}

export interface BudgetConfig {
  /** Max per single payment, in whole tokens (e.g. CSPR). */
  maxPerCall: string
  /** Max per calendar day, in whole tokens. */
  maxPerDay: string
}

export interface WalletFileConfig {
  casperSecretKey?: string
  network?: string
  createdAt?: string
}

export interface SpendingRecord {
  recipient: string
  amount: string
  network: string
  timestamp: string
}
