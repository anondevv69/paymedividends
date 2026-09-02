# Operations rollout — getting holder claims live

This is the checklist to move from **contracts live** to **holders claiming RWA pro-rata**.

## Product entry points (only two)

| Path | Who | How |
|---|---|---|
| **New token** | Launcher | app.paymedividends.xyz → router + Bankr deploy (API key in browser) |
| **Existing token** | Fee beneficiary | Bankr bot skill **or** site “I already have a token” (same wallet) |

There is no “launch on Bankr separately” path. External launches must use Bankr’s skill/API against our enrollment + verify flow.

---

## Phase 1 — Per token (creator / fee beneficiary)

### A. New launch (site)

1. Connect wallet → create router → Bankr deploy with router as `feeRecipient`
2. Verify ≥95% fee share onchain (automatic)
3. Submit **Request Hub enrollment** in the wizard (queues for governance)

### B. Existing token (site or Bankr skill)

1. Connect **fee beneficiary** wallet
2. Pick token from beneficiary list (Bankr `GET /public/doppler/beneficiary-fees/:wallet`)
3. Create holder router
4. **Retarget fees** — site calls Bankr `build-transfer-beneficiary`, wallet signs `updateBeneficiary`
5. Re-verify fee share
6. Submit enrollment request

Bankr skill spec: [bankr-join-sink-skill.md](./bankr-join-sink-skill.md)

---

## Phase 2 — Governance Safe (manual v1)

For each enrollment request, Safe owners:

1. **Verify onchain**
   - Router from factory: `isProjectRouter(router) == true`
   - `getShares(poolId, router) >= 0.95e18`
   - Token/pool binding matches Bankr API + Robinhood fork test pattern

2. **Verify activity** (anti free-rider)
   - 30d fees / volume from `GET /token-launches/:token/fees?days=30`
   - Paired RWA ecosystem (e.g. DEVS → MSFT pool)

3. **Register pool** (if not already)
   - `setApprovedPoolBinding(feeManager, poolId, communityToken, pairedAsset, true)`
   - `setApprovedAsset(pairedAsset, true)` if needed

4. **Schedule enrollment**
   - `enrollMemberRouter(router, memberToken)` → 7-day public delay

5. **Activate**
   - After delay: `activateMemberRouter(memberToken)`

6. **Router admin binds launch** (if not done)
   - `bindBankrDopplerLaunch(...)` from `projectAdmin` wallet

---

## Phase 3 — Indexer + claims (worker)

### Current state

- Worker runs **hourly dry-run** (`EXECUTION_MODE=disabled`)
- Builds pro-rata manifests when given `memberTokens`, `snapshotBlock`, `allocationPerCommunity`
- Does **not** auto-start Hub rounds or submit roots

### To enable

1. **Optional Postgres** (`DATABASE_URL`) — see `docs/indexer-schema.sql` for checkpoint tables
2. **Volume** on worker (`MANIFEST_DIR=/data/manifests` on Railway) — manifests + file checkpoints
3. **Enrolled token list** fed to worker (env `ENROLLED_MEMBER_TOKENS` or read from chain events)
4. **Governance / snapshot Safe** starts equal-slice rounds on Hub
5. **projectAdmin** EIP-712-signs each community manifest
6. **24h review** → finalize round → holders claim via Merkle proofs

Holder snapshots are **on-demand**: the worker runs one `eth_getLogs` Transfer pass per token at `snapshotBlock`, optionally continuing from a file/Postgres checkpoint — it does **not** keep full transfer history in memory.

### Enrollment holder gates (API)

Default gates (override via env):

```env
ENROLLMENT_MIN_TOTAL_HOLDERS=100
ENROLLMENT_MIN_QUALIFIED_HOLDERS=100
ENROLLMENT_MIN_QUALIFIED_BALANCE=10000000
```

- `GET /v1/tokens/:tokenAddress/holder-stats` — Robinscan screening for the wizard
- `POST /v1/enrollment-requests` — stores `holderQualification.passed` on each queue row
- Site launches send `skipHolderChecks: true` / `launchSource: pmd`

### Railway worker env (today)

```env
EXECUTION_MODE=disabled
UNIVERSAL_REWARDS_HUB=0x6844D0814E904722777A48Ae2CF7C4b8F78a19e5
PROJECT_ROUTER_FACTORY=0x4AD615B99e2B6E8e2C322c657Ac8f81F1806A3a7
TARGET_CHAIN=robinhood
MANIFEST_DIR=/data/manifests
WORKER_POLL_INTERVAL_MS=3600000
```

### Meme fee → paired RWA conversion

In a `$DEVS` / `$MSFT` pool, fee collection splits cleanly:

| Leg | Asset | Path |
|---|---|---|
| Quote/RWA fees | MSFT | Router → Hub deposit (direct, no swap) |
| Meme fees | DEVS | Router → adapter → executor → MSFT → Hub deposit |

Non-RWA meme fees must use `SwapToSettlement` policy with `MemeToSettlementAdapter`. The executor registers **one hop per meme**: meme → paired RWA (e.g. DEVS → MSFT). MSFT is never swapped to SPY — it is already an approved RWA.

1. **Deploy** (`script/DeployMemeSettlement.s.sol` on chain 4663):

```env
UNIVERSAL_REWARDS_HUB=0x6844D0814E904722777A48Ae2CF7C4b8F78a19e5
GOVERNANCE_SAFE=<safe>
DEPLOYER_PRIVATE_KEY=<key>
```

2. **Register routes** on `RobinhoodMemeSwapExecutor` per meme token:

```bash
# discovers all pool-bound SwapToSettlement routers + enrollment queue rows
MEME_SWAP_EXECUTOR=0xc28619a3e810b984B1d885E27858d405244971E1 \
GOVERNANCE_SAFE=0x34A6cD0EE9704090AA0Aa3e2957a81Bb75029e84 \
PROJECT_ROUTER_FACTORY=0x4AD615B99e2B6E8e2C322c657Ac8f81F1806A3a7 \
MANIFEST_DIR=/data/manifests \
npm run route-builder
```

Import `artifacts/route-builder/safe-batch.json` into the Governance Safe (Transaction Builder → Import). Sign once — one `registerMemeRouteSimple` tx per sink token. No manual swaps.

3. **Keeper runtime quotes** (after routes are registered):

Default provider is **Doppler pool quotes** (`SWAP_QUOTE_PROVIDER=auto` or `doppler`) — swaps DEVS → MSFT through the token's Doppler V4 pool via Robinhood's Universal Router. No 0x API key required.

Optional 0x fallback (`SWAP_QUOTE_PROVIDER=auto` + `ZEROX_API_KEY`) or forced 0x (`SWAP_QUOTE_PROVIDER=0x`). Robinhood RWAs may require 0x opt-in.

```env
SWAP_QUOTE_PROVIDER=doppler
MEME_SWAP_EXECUTOR=0xc87498E933d624e40E791322191ab03c7335057e
KEEPER_PRIVATE_KEY=<keeper wallet>
EXECUTION_MODE=keeper_live
```

Keeper flow per collection: `collect` → `setRuntimeSwap` (fresh Doppler or 0x quote) → `processMemeAsset`.

**Note:** Universal Router swaps require Permit2. Redeploy `RobinhoodMemeSwapExecutor` after pulling the latest contract if your live executor predates Permit2 support.

**Note:** the executor deployed before `registerMemeRouteSimple` / `setRuntimeSwap` must be redeployed. Re-run `DeployMemeSettlement.s.sol`, update `MEME_TO_PAIRED_ADAPTER` + `MEME_SWAP_EXECUTOR`, then run `npm run route-builder`.

```env
MEME_TO_PAIRED_ADAPTER=0x...   # preferred name
MEME_SWAP_EXECUTOR=0x...
```

4. **Keeper** (dry-run first):

```env
EXECUTION_MODE=keeper_dry_run   # or keeper_live
KEEPER_MIN_SETTLEMENT_OUT=1     # router requires non-zero minOut for swaps
SWAP_QUOTE_PROVIDER=doppler     # auto | doppler | 0x
SWAP_SLIPPAGE_BPS=100
# Optional UK/residential proxy for Doppler RPC quotes (not required for 0x):
# DOPPLER_HTTP_PROXY=host:3128:username:password
# Multiple proxies (random per quote): comma-separated list
KEEPER_PRIVATE_KEY=<key>        # required for keeper_live only
ZEROX_API_KEY=<key>             # optional unless SWAP_QUOTE_PROVIDER=0x
```

The hourly worker calls `collectAndRouteBankrDopplerFees(minOut)` and `processMemeAsset(minOut)` on every factory router with `SwapToSettlement` policy. Approved RWA quote assets still deposit directly to the Hub.

**Note:** Routers already created with `QuoteOnly` cannot change policy — create a new router and retarget Bankr fees.

### API enrollment queue

```env
MANIFEST_DIR=/data/manifests
```

- `POST /v1/enrollment-requests` — wizard / Bankr skill submits
- `GET /v1/enrollment-requests` — governance reviews queue
- `GET /v1/directory` — public sink index (routers, enrollment status, Doppler market cap / holders)
- `GET /v1/universal` — alias for directory index

---

## Phase 4 — Bankr bot skill (their side)

Bankr implements skill using:

- `GET /public/doppler/beneficiary-fees/:wallet` — list tokens
- Our `GET /v1/bankr/beneficiary-fees/:wallet` — filtered Robinhood + stock pairs
- Our `POST /v1/enrollment-requests` — after verify
- Deep link: `https://app.paymedividends.xyz/#test-lab?token=0x…`

For fee retarget on external wallet, Bankr already exposes:

- `POST /public/doppler/build-transfer-beneficiary`

---

## DEVS example (first production candidate)

| Field | Value |
|---|---|
| Token | `0x80db362eab104ec378e19d0a3dcd5e84bafd4ba3` |
| Fee beneficiary | `0x374d91a5674fa7cf86e725093b5848b97e1e13b4` |
| Pool | `0x130caf8b…` |
| Pair | DEVS / MSFT |

Steps: beneficiary wallet → join sink → retarget → verify → enrollment request → Safe enrolls → MSFT ecosystem pool.

---

## What “live” looks like for holders

1. Token enrolled + activated on Hub
2. Trading generates MSFT fees → router → Hub deposit
3. Governance starts MSFT round, snapshot block chosen
4. Worker indexes DEVS holders → manifest + Merkle root
5. Router admin signs root
6. After review delay, holders claim MSFT from claim UI (coming after round infra)

Until Phase 3 completes, **fees can flow to the router/Hub but public claim UI is not production-ready**.
