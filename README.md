# Pay Me Dividends

Tokenless shared-RWA reward infrastructure for Bankr/Doppler token communities. Each enrolled token
uses an isolated Project Router for its fee stream; approved quote/RWA assets can reach a shared
Hub, which reserves multi-asset Merkle claim rounds for all verified member-token holders.

> The Solidity contracts currently in this repository are the **v1 dedicated-payout foundation**.
> They are not the final v2 shared-Hub architecture and must not be used for a mainnet universal
> deployment. The v2 contract plan is described below and still needs implementation, fork tests,
> audit, and a controlled test deployment.

## v2 tokenless shared-Hub target

```text
Bankr/Doppler fee stream (meme token + quote/RWA)
→ isolated ProjectRouter (one per member token)
→ approved quote/RWA → UniversalRewardsHub
→ transparent Hub infrastructure split (policy-controlled)
→ multi-asset Merkle rounds
→ holders of every verified member token claim
```

- `UniversalRewardsHub` accepts only allowlisted RWA/numeraires and is the shared accounting and
  claim boundary. It has no platform token.
- `ProjectRouterFactory` creates one isolated router per enrolled Bankr/Doppler token.
- `ProjectRouter` forwards approved quote/RWA assets to the Hub and applies an immutable policy to
  any received meme asset: quote-only bypass, burn, lock, or a bounded audited swap adapter.
- Snapshot roots must be produced from reproducible manifests and authorized in v1; a permissionless
  publisher needs bonding/challenge rules before it can safely earn a keeper bounty.

## Archived v1 dedicated-payout flow

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

## Target Bankr + Doppler flow

The first target integration is Bankr launches on Robinhood Chain, which use Doppler pools. The v2
deployment flow is intentionally two-step because Bankr needs a fee-recipient address before it
creates the token:

1. The creator creates a Project Router and receives its address.
2. The creator launches their Bankr token on Robinhood Chain with that router as the wallet `feeRecipient`.
3. Bankr returns the token address and Doppler `poolId`; the router is bound and enrolled in the Hub only
   after onchain verification.
4. The shared keeper indexes holder snapshots and proposes a reproducible multi-asset Merkle round. It
   cannot move funds or publish an arbitrary root until the v2 authorization design is in place.

The onchain integration is Doppler-compatible; `Bankr` is stored by the API as the launch source and
the router stores the fee manager + pool ID. Do not use a Bankr user API key as a platform secret. For
Robinhood Chain launches, the creator should use their own Bankr wallet flow and approve the launch
transaction. Bankr documents Robinhood as a supported Doppler launch chain, while its partner-key
launch flow is Base-only: <https://docs.bankr.bot/token-launching/api-reference/deploy-token-launch/>.

## V2 contracts to deploy — in this order

1. `UniversalRewardsHub`: a tokenless, chain-specific Hub with an approved-asset allowlist, member
   router registry, transparent ops/keeper fee configuration, round accounting, and Merkle claims.
2. `ProjectRouter` implementation + `ProjectRouterFactory`: a chain-specific factory that creates an
   isolated router for every Bankr token. Router configuration is immutable after binding.
3. `ApprovedAssetRegistry` only if it is not embedded in the Hub: a tightly governed allowlist for
   quote/RWA assets. The Hub must reject arbitrary meme tokens.
4. A chain/venue-specific `SwapAdapter` only after a separate fork test and audit. Quote-only Bankr
   fees do not need it.

Do **not** deploy a new Doppler fee manager: it is venue infrastructure. Do **not** deploy the old
`PayoutVaultFactory` as the shared index; it is the v1 foundation below, not the final v2 system.

## Archived v1 contract model

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
