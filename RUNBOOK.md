# MidOS × Pulse — autonomous on-chain payments on Casper

An AI agent with a self-custody Casper wallet pays for real data, per call,
**on-chain** — no API keys, no subscriptions, no human in the loop.

- **MidOS** — the agent's wallet, exposed as MCP tools (`x402_fetch`, `pay`,
  `transfer_cspr`, `check_balance`, …).
- **Pulse** — a pay-per-call data API. Endpoints (`/v1/weather`, `/v1/markets`)
  are gated behind HTTP `402`; you pay per request.
- **Facilitator** — verifies each payment on Casper testnet before data is released.

Every payment is a real transaction you can open on
[testnet.cspr.live](https://testnet.cspr.live).

## How a paid call works (`casper-native`)

```
agent ──GET /v1/weather?city=Tokyo──▶ Pulse
      ◀──402 + price + payTo──────────  (2.5 CSPR to the seller, transferId)
wallet ──native CSPR transfer───────▶ Casper testnet     (real deploy, real gas)
wallet ──wait for finalization──────▶ node
agent ──retry + Payment-Deploy──────▶ Pulse ─▶ facilitator verifies on-chain:
                                                success? to seller? amount ok?
                                                payer ok? not already used?
      ◀──200 + live weather + hash───  ✓ settled on-chain
```

No off-chain settlement, no mock. The acknowledgement *is* a finalized testnet
deploy hash.

## Prerequisites

- Node 18+, and `npm install && npm run build` from the repo root.
- A funded Casper testnet account (the wallet): secret key at
  `.secret/Account 1_secret_key.pem`, ~5,000 testnet CSPR.
- For the autonomous agent runner: an `ANTHROPIC_API_KEY`
  (https://console.anthropic.com).

## 1. Start the services

```bash
# Terminal 1 — facilitator (on-chain verification)
npm run facilitator

# Terminal 2 — Pulse data API
npm run pulse
```

Browse the free catalog to see what's for sale: `curl http://127.0.0.1:3002/`.

## 2a. Drive it from Claude Desktop

With MidOS configured (see the root README), restart Claude Desktop and ask:

> "Using `x402_fetch`, get me the current weather in Tokyo from
> `http://127.0.0.1:3002/v1/weather?city=Tokyo` and pay for it."

or

> "Get me live CSPR, BTC and ETH prices from `http://127.0.0.1:3002/v1/markets`."

The agent hits the 402, pays on-chain, waits for finalization, and returns the
live data plus the `deployHash` + cspr.live link. (Claude Desktop permits
`x402_fetch` as paying an API; it asks once and proceeds.)

## 2b. Drive it from the autonomous agent runner (no prompts)

A real agent loop (Claude + the MidOS tools), no approval step:

```bash
ANTHROPIC_API_KEY=sk-ant-...                              \
CASPER_SECRET_KEY="$PWD/.secret/Account 1_secret_key.pem" \
NETWORK=casper-test                                       \
CASPER_NODE_URL=https://node.testnet.casper.network/rpc   \
MAX_PER_CALL=5.0 MAX_PER_DAY=50.0                         \
npm run agent -- "Get me the weather in Tokyo from http://127.0.0.1:3002/v1/weather?city=Tokyo"
```

## 3. Prove it on-chain

- Open the `explorerUrl` from the output, or your account:
  `https://testnet.cspr.live/account/020284e076583223020a2e7e86a8993b902a1c2787aa5c133436775996710593a060`
- Inspect any settlement deploy:
  ```bash
  CASPER_NODE_URL=https://node.testnet.casper.network/rpc npm run verify-deploy -- <deployHash>
  ```

## Guarantees

- **Budget caps** enforced before any signature (`MAX_PER_CALL` / `MAX_PER_DAY`).
- **Self-custody** — the key signs locally; nothing is sent to a backend.
- **Replay-proof** — one deploy settles exactly one request.
- **Forgery-resistant** — Pulse enforces its price/recipient; the facilitator
  confirms the on-chain transfer matches.

## Notes

- Native CSPR transfers have a ~2.5 CSPR minimum, so per-call prices start at 2.5
  CSPR. The seller must differ from the payer (self-transfer fails on Casper).
- The agent runs outside Claude Desktop on purpose for fully unattended runs;
  the desktop app gates direct transfers.
- If testnet RPC flakes, change `CASPER_NODE_URL`. Only payment/verification touch
  the node.
