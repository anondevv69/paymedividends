# Pay Me Dividends

Self-service payout vaults for token communities. Each project receives creator-fee revenue,
optionally converts it into a chosen payout asset, pays a transparent platform service fee, and
reserves the remainder for token-holder claims.

## v1 economic flow

For a project token paired with NVDA:

```text
TEST creator-fee revenue → project PayoutVault
→ trusted, configured swap adapter
→ actual NVDA received
→ 5% NVDA platform service fee
→ 95% NVDA reserved in a Merkle payout round
→ TEST holders claim their allocation
```

The platform fee is charged only on actual payout-asset revenue received by the vault. It is not a
fee on users' wallets, existing liquidity, or a payout round that has already been reserved.

## Bankr + Doppler on Robinhood Chain

The first integration is Bankr launches on Robinhood Chain, which use Doppler pools. The deployment
flow is intentionally two-step because Bankr needs a fee-recipient address before it creates the
token:

1. The creator calls `createPrelaunchBankrDopplerProject(payoutAsset, minimumRoundPayout)` and gets a vault address.
2. The creator launches their Bankr token on Robinhood Chain with that vault as the wallet `feeRecipient`.
3. Bankr returns the token address and Doppler `poolId`; the creator calls `bindBankrDopplerLaunch(...)` once.
4. The shared Railway keeper calls `claimBankrDopplerFees()`. Direct payout-asset fees are split 5% to the
   platform treasury and 95% to the project reserve. A second received asset can be converted through the
   vault's fixed swap adapter before receiving the same split.

The onchain integration is Doppler-compatible; `Bankr` is stored by the API as the launch source and
the vault stores the fee manager + pool ID. Do not use a Bankr user API key as a platform secret. For
Robinhood Chain launches, the creator should use their own Bankr wallet flow and approve the launch
transaction. Bankr documents Robinhood as a supported Doppler launch chain, while its partner-key
launch flow is Base-only: <https://docs.bankr.bot/token-launching/api-reference/deploy-token-launch/>.

## Contract model

- `PayoutVaultFactory`: deploys a cheap isolated EIP-1167 vault for every project.
- `PayoutVault`: stores the project configuration, settles revenue, reserves rounds, and pays claims.
- `IPayoutSwapAdapter`: a chain/venue-specific, pre-approved adapter. The vault does **not** expose
  arbitrary router calls.
- `PayoutVault` configuration is set once: holder token, source asset, payout asset, platform
  treasury, 5% fee, adapter, and minimum round amount.

The creator can pause future revenue processing or rotate the automation wallet, but has no
function to withdraw payout assets, platform fees, or funds reserved for claims. Existing claims
remain available while the vault is paused.

## What is deliberately not deployed yet

This is a tested contract foundation, not a production launch. Before mainnet funds:

1. Build and audit venue-specific swap adapters for the target chain(s).
2. Build the indexed snapshot + Merkle manifest service and make each round publicly reproducible.
3. Add the worker queue, database, monitoring, and reorg handling.
4. Run fuzz/invariant tests and obtain an independent smart-contract audit.
5. Obtain legal review before supporting tokenized-stock payout assets or marketing payout history as returns.

## Local verification

Requires Foundry:

```bash
forge test
```

## Railway control plane

Railway runs the shared API and worker for every project; users do not get their own Railway service.
The API exposes only setup and status endpoints right now:

```bash
npm start
# http://localhost:3000/health
# http://localhost:3000/v1/platform
```

The worker is deliberately safe by default:

```bash
npm run start:worker
```

`EXECUTION_MODE=disabled` is the only accepted mode in this initial release. It cannot sign a
transaction, claim launch fees, or move payout funds. The production sequence is: add Postgres and
a queue, deploy audited chain/venue adapters, create the factory, then enable a separately secured
keeper after a security review.

The API uses Railway's assigned `PORT` and an optional `PUBLIC_PORT` (default `3000`). This makes the
healthcheck and service domain work even if an existing Railway domain was previously pinned to 3000.

## Current scope

The factory accepts a fixed platform fee selected when the platform factory is deployed. The tests
use `500` basis points (5%). A new policy requires a new factory/version; it cannot silently change
existing project economics.
