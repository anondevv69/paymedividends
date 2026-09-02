# Pay Me Dividends × Bankr API reference

## Eligible pool types

| Pool shape | Example | Eligible? |
|---|---|---|
| Meme + tokenized stock | DEVS / MSFT | **Yes** |
| Meme + tokenized stock | TEST / NVDA | **Yes** |
| Meme + WETH only | TOKEN / WETH | **No** |
| Single-asset | — | **No** |

Filter beneficiary list: `chain === "robinhood"`, share ≥ 95%, quote leg is stock/RWA (not WETH).

## Token roles in a stock-paired pool

| Role | API / indexer field | Fee path (SwapToSettlement router) |
|---|---|---|
| **Community / meme token** | `baseToken`, community token | Collected as meme leg → swapped to paired RWA via Doppler pool → Hub |
| **Paired quote / RWA** | `quoteToken`, numeraire | Collected as quote leg → Hub **direct** (no swap) |

Both legs are paid on every `collectFees`. Traders paying fees in either direction produce a **split** of meme + RWA tokens to the beneficiary (the router after retarget).

## Manual claim vs sink routing

| Stage | Beneficiary | On claim / collect |
|---|---|---|
| **Before sink** | Creator wallet | Bankr/Doppler “claim fees” → wallet receives **DEVS + MSFT** unchanged |
| **After sink** | Project Router | Keeper `collectAndRouteBankrDopplerFees` → MSFT direct to Hub; DEVS swapped to **MSFT** (not SPY) then Hub |

Users describing “I claim and get DEVS and MSFT” are on the **before sink** path. Joining the sink **retargets** the beneficiary to the router and stops raw meme tokens from landing in the wallet.

## Three “claims” (different systems)

| Claim type | Contract / UI | Actor | Pays out |
|---|---|---|---|
| Creator fee claim | Doppler fee manager / Bankr | Fee beneficiary wallet | DEVS + MSFT split |
| Fee collect & route | `ProjectRouter.collectAndRouteBankrDopplerFees` | Keeper worker | Hub deposit (MSFT for DEVS pool) |
| Holder dividend | `UniversalRewardsHub.claim(roundId, …)` | Token holders | Paired RWA (MSFT) via Merkle proof |

Router = fee routing only. Hub = holder dividends. No holder `claim()` on ProjectRouter.

### What is *not* swapped

- Tokenized stocks (MSFT, NVDA, …) — already the reward asset; deposit directly
- Never converted to SPY (SPY is a separate Hub asset for other ecosystems)
- Never converted to WETH

### What *is* swapped

- Meme/community token only (DEVS, …)
- Always to **that pool’s** paired RWA (DEVS→MSFT, not DEVS→SPY)

## Router policies

Immutable at router creation:

| `memeAssetPolicy` | Value | Meme fees | RWA fees |
|---|---|---|---|
| QuoteOnly | 0 | Held on router | Hub direct |
| Burn | 1 | Burned | Hub direct |
| Lock | 2 | Sent to lockbox | Hub direct |
| **SwapToSettlement** | 3 | Swap → paired RWA → Hub | Hub direct |

Holder sink requires **SwapToSettlement** (`3`). QuoteOnly routers cannot be upgraded — retarget to a new router.

Verify: `cast call $ROUTER "memeAssetPolicy()(uint8)"` → must return `3`.

## Bankr deploy vs router policy

| Setting | Where | Purpose |
|---|---|---|
| `quoteOnlyFees: true` | Bankr `POST /token-launches/deploy` | Doppler launch config |
| `SwapToSettlement` | `ProjectRouterFactory.createPrelaunchRouter` | Pay Me Dividends meme-fee handling |

Both can apply to the same token. The router policy controls post-collection behavior.

## Keeper (automatic — not Bankr bot)

Pay Me Dividends worker (`EXECUTION_MODE=keeper_dry_run` or `keeper_live`):

1. `collectAndRouteBankrDopplerFees(minOut)` — pulls split fees from Doppler
2. RWA leg → `_routeApprovedAsset` → Hub
3. Meme leg → quote DEVS→MSFT (Doppler V4 pool) → `setRuntimeSwap` → `processMemeAsset` → Hub

Swap quotes use the **same Doppler pool** as the token launch, not 0x (0x optional fallback only).

## List eligible tokens

```http
GET https://api.bankr.bot/public/doppler/beneficiary-fees/:walletAddress
```

Filter: `chain === "robinhood"`, parse `share >= 95`, one pool leg is stock/RWA (e.g. MSFT), not WETH-only.

Pay Me Dividends proxy (pre-filtered):

```http
GET https://api.paymedividends.xyz/v1/bankr/beneficiary-fees/:walletAddress
```

Until custom-domain TLS is fixed, use:

```http
GET https://paymedividends-production.up.railway.app/v1/bankr/beneficiary-fees/:walletAddress
```

## Token details

```http
GET https://api.bankr.bot/token-launches/:tokenAddress
```

Returns `poolId`, `feeRecipient`, `quoteToken` / paired stock metadata.

## Retarget fees (external wallet)

```http
POST https://api.bankr.bot/public/doppler/build-transfer-beneficiary
Content-Type: application/json

{
  "tokenAddress": "0x…",
  "currentBeneficiary": "0x…",
  "newBeneficiary": "0x…router"
}
```

Response: `{ "to", "data", "chainId", "description" }` — sign with current beneficiary.

Bankr-managed wallet alternative: `POST /user/doppler/execute-transfer-beneficiary` (sponsored gas).

## Verify onchain

`getShares(poolId, router)` on fee manager `0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544` — require `>= 0.95e18`.

Also verify:

- `router.poolBound() == true`
- `router.memeAssetPolicy() == 3` (SwapToSettlement)
- `router.pairedAsset()` matches pool quote token (e.g. MSFT)
- `router.communityToken()` matches meme token (e.g. DEVS)

## Queue Hub enrollment

```http
POST https://api.paymedividends.xyz/v1/enrollment-requests
Content-Type: application/json

{
  "tokenAddress": "0x…",
  "router": "0x…",
  "poolId": "0x…",
  "feeBeneficiary": "0x…",
  "tokenSymbol": "DEVS",
  "pairedStockSymbol": "MSFT",
  "requestedBy": "0x…"
}
```

Governance polls: `GET /v1/enrollment-requests`

Enrollment queues **holder claims** in the paired RWA ecosystem (MSFT pool for DEVS). It does not change fee routing — that happens at router setup + keeper.

## Holder screening (before enrollment)

```http
GET https://api.paymedividends.xyz/v1/tokens/0x…/holder-stats?minQualifiedBalance=10000000
```

Returns Robinscan holder counts for default gates (100 total holders, 100 wallets ≥ 10M tokens). Payout rounds still use onchain Transfer snapshots.

Enrollment POST stores `holderQualification.passed` on the queue row. Site launches may send `skipHolderChecks: true`.

## Platform constants (Robinhood mainnet)

| Contract | Address |
|---|---|
| ProjectRouterFactory | `0x4AD615B99e2B6E8e2C322c657Ac8f81F1806A3a7` |
| UniversalRewardsHub | `0x6844D0814E904722777A48Ae2CF7C4b8F78a19e5` |
| Fee manager | `0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544` |
| MemeToSettlementAdapter | `0x02f1eb8D7005367476d840B1aBe292c76Ec04CA4` |
| MemeSwapExecutor | `0xc87498E933d624e40E791322191ab03c7335057e` |

## New token launch (not this skill)

Site only: [app.paymedividends.xyz](https://app.paymedividends.xyz) — create **SwapToSettlement** router, then `POST /token-launches/deploy` with `feeRecipient: { type: "wallet", value: router }` and `quoteOnlyFees: true`.

Full ops runbook: [docs/ops-rollout.md](https://github.com/anondevv69/paymedividends/blob/main/docs/ops-rollout.md)
