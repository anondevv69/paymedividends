# Pay Me Dividends

Tokenless shared-RWA reward infrastructure for Bankr/Doppler token communities. Each enrolled token
uses an isolated Project Router for its fee stream; approved quote/RWA assets can reach a shared
Hub, which reserves multi-asset Merkle claim rounds for all verified member-token holders.

> The v2 contracts are implemented but remain **pre-mainnet**. They require a production archive RPC,
> a real 2-of-3 Robinhood Safe, an executed Bankr/Doppler fork test, fuzz/invariant coverage, and an
> independent external audit before deployment. The archived v1 contracts remain in the repository
> only for reference and are not part of the universal deployment.

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
- The Router implements Bankr's published Doppler ABI: it verifies at least a 95% beneficiary share with
  `getShares(poolId, router)`, then lets anyone trigger `collectFees(poolId)` and forwards approved
  paired/RWA assets to the Hub.
- Snapshot roots are generated offchain because arbitrary ERC-20 contracts do not expose historical
  holder enumeration. The platform tunnel indexes every enrolled member token's holders at one
  finalized block, publishes a public manifest per community, and each community `projectAdmin`
  must EIP-712-sign that community's root/manifest commitment. Anyone may submit a valid signed
  batch. Roots remain under a 24-hour public review where the same admin can veto; vetoed digests
  are permanently blacklisted so prior signatures cannot be replayed. Round creation itself is
  limited to the governance Safe or a separate 2-of-3 snapshot-committee Safe.
- Round membership is frozen by onchain membership windows, so later enrollments or removals cannot
  alter an already-started round. Claim deadlines are capped at 90 days.
- Only routers created by the canonical factory can enroll. Every pool identity is recorded by the
  governance Safe after matching Bankr API data to onchain Doppler events, then waits seven days before
  membership activates. v1 admission stays Safe-curated so zero-volume tokens cannot free-ride.

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
3. Bankr returns the token address, paired asset, fee-manager initializer, and Doppler `poolId`.
4. Governance records that exact pool identity after API/event verification. The router binds only
   after the registered identity matches and `getShares(poolId, router)` is at least 95%.
5. Governance schedules enrollment; anyone can activate it after the seven-day admission delay.
6. Anyone can collect the pool's creator fees through the router. For the production launch path,
   Bankr `quoteOnlyFees: true` avoids a creator-token fee leg.
7. Every 30 minutes the platform tunnel can collect fees and index holders of every enrolled member
   token (each Project Router that is a Bankr fee recipient) at one finalized block. Reward rounds
   should publish on an hourly/daily cadence at ~100-token scale. Each community admin signs its
   public root/manifest commitment; veto remains available during the 24-hour review.

The onchain integration is Doppler-compatible; the router stores the paired asset, fee manager, and
pool ID. Robinhood launches require the creator's own Bankr user API key; Bankr partner-key launches
are Base-only. Never commit, persist, or send a user key to the platform backend; a browser-assisted
launch must call Bankr directly and keep the key only in memory. The launch endpoint supports a
non-broadcasting `simulateOnly: true` preflight:
<https://docs.bankr.bot/token-launching/api-reference/deploy-token-launch/>.

## V2 contracts to deploy — in this order

1. `ProjectRouter` implementation + `ProjectRouterFactory`: a chain-specific factory that creates an
   isolated router for every Bankr token. Router configuration is immutable after binding.
2. `UniversalRewardsHub`: a tokenless, chain-specific Hub bound to that factory, with an approved-asset
   and verified-pool registry, delayed member admission, round accounting, and Merkle claims.
3. A chain/venue-specific `SwapAdapter` only after a separate fork test and audit. Quote-only Bankr
   fees do not need it.

Do **not** deploy a new Doppler fee manager: it is venue infrastructure. Do **not** deploy the old
`PayoutVaultFactory` as the shared index; it is the v1 foundation below, not the final v2 system.

### Current v2 test coverage

The local v2 suite verifies the core economic boundaries before an audited deployment:

- deposit accounting applies the fixed Hub fee once and reserves net rewards;
- every active community receives the same maximum share in an equal-slice round;
- each community's root cannot claim above its equal allocation;
- a forged community signature cannot invent a root for another project;
- round membership stays frozen after the round starts;
- roots cannot finalize until their 24-hour public review delay passes;
- a project admin can veto its own proposed root before activation, and the vetoed digest cannot be
  replayed;
- claim deadlines cannot exceed the 90-day maximum window;
- newly scheduled communities cannot activate during their seven-day admission delay;
- the Router uses Bankr's published `getShares` and `collectFees` interface;
- approved RWA assets route directly to their own Hub bucket;
- a fixed swap adapter can convert a meme fee balance into the Hub settlement asset (SPY in the
  intended mainnet configuration).

Create a Robinhood Safe only after setting three distinct owner addresses. This script enforces a
2-of-3 threshold and verifies Safe's canonical v1.5.0 Robinhood contracts before broadcasting:

```bash
set -a && source .env.deploy && set +a
forge script script/CreateRobinhoodGovernanceSafe.s.sol:CreateRobinhoodGovernanceSafe \
  --rpc-url "$ROBINHOOD_MAINNET_RPC_URL" --broadcast
```

The Hub deployment script accepts only chain ID `4663`, hardcodes canonical Robinhood `$SPY` as the
settlement asset, and rejects governance, ops, and `SNAPSHOT_SIGNER` unless each is a canonical Safe
v1.5.0 proxy with **exactly** three owners and threshold **exactly** two. `SNAPSHOT_SIGNER` is the
round-operator committee Safe and must never be the deployer key. Community root attestations are
signed by each router's `projectAdmin`, not by that committee. Do not use `--broadcast` until the
external audit has signed off on the final commit.

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
2. Wire the in-repo transfer indexer to a production archive RPC + Postgres cursor store, and pin
   `pmd://` manifests to IPFS (or equivalent).
3. Enable the audited transaction keeper for fee collection and signed root submission.
4. Run fuzz/invariant tests and obtain an independent smart-contract audit.
5. Obtain legal review before supporting tokenized-stock payout assets or marketing payout history as returns.

## Local verification

Requires Foundry and Node 20+:

```bash
forge test
npm test
```

## Railway control plane

Railway runs the shared API and worker for every project; users do not get their own Railway service.
The API exposes only setup and status endpoints right now:

```bash
npm start
# http://localhost:3000/health
# http://localhost:3000/v1/platform
```

The worker now runs the dry-run snapshot pipeline on the default 30-minute cadence:

```bash
npm run start:worker
```

`WORKER_POLL_INTERVAL_MS` defaults to `1800000` (30 minutes) for fee/index progress.
`REWARD_ROUND_INTERVAL_MS` defaults to one hour so ~100-token membership does not publish a full
Merkle batch every poll. Manifests are content-addressed under `pmd://<hash>` (optionally mirrored
to `MANIFEST_DIR`). `EXECUTION_MODE=disabled` remains the only accepted mode: the worker can build
roots and store manifests, but it cannot sign community approvals, submit transactions, collect
fees, or move payout funds until a separately audited keeper is enabled.

The API uses Railway's assigned `PORT` and an optional `PUBLIC_PORT` (default `3000`). This makes the
healthcheck and service domain work even if an existing Railway domain was previously pinned to 3000.

## Current scope

The factory accepts a fixed platform fee selected when the platform factory is deployed. The tests
use `500` basis points (5%). A new policy requires a new factory/version; it cannot silently change
existing project economics.
