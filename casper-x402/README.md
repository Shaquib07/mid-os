# Casper x402 — Pulse data API + facilitator

A self-contained Casper x402 stack you can run locally:

- **`resource-server/` → Pulse**, a pay-per-call data API. Real endpoints
  (`/v1/weather`, `/v1/markets`) are gated behind HTTP `402`; callers pay per
  request with a native CSPR transfer.
- **`facilitator/`** verifies each payment **on-chain** (the transfer is
  finalized, goes to the seller for the right amount, from the right payer, and
  hasn't been used before) before the data is released.
- **`e2e-client.mjs`** drives the MidOS wallet through one paid call end-to-end.

Both share the EIP-712 / settlement primitives in
[`x402-casper-core`](../packages/x402-casper-core) with the MidOS wallet, so
signer and verifier can't drift.

## Run it

From the repo root:

```bash
npm install
npm run build

# Terminal 1 — on-chain settlement facilitator (:3001)
npm run facilitator

# Terminal 2 — Pulse data API (:3002)
npm run pulse
```

Then point an agent (or the wallet) at a paid endpoint — e.g.
`http://127.0.0.1:3002/v1/weather?city=Tokyo`. The free catalog at
`http://127.0.0.1:3002/` lists every endpoint and its price.

See [`RUNBOOK.md`](../RUNBOOK.md) for the full agent walkthrough.

## Settlement (`casper-native`)

The payer submits a real native CSPR transfer to the seller; the facilitator
verifies it on Casper testnet via `getDeploy`. Native transfers have a ~2.5 CSPR
minimum, so prices start at `2_500_000_000` motes. The `transferId` from the 402
binds a transfer to its request, and consumed deploys can't be replayed.
