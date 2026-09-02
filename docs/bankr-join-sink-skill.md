# Bankr skill: Join the Pay Me Dividends holder sink

Installable skill files live at [`skills/join-holder-sink/`](../skills/join-holder-sink/) (Bankr `SKILL.md` + `catalog.json`). For Bankr Discover catalog listing, open a PR to [BankrBot/skills](https://github.com/BankrBot/skills) copying that folder under a `paymedividends/` provider path.

Natural-language entry points:

- "Join the Pay Me Dividends holder sink"
- "Route my token fees to holders pro-rata"
- "I want my Bankr token in the shared RWA rewards pool"

This skill is for **existing Bankr tokens** where the user's wallet is already the **fee beneficiary**. New launches use [app.paymedividends.xyz](https://app.paymedividends.xyz) directly (router first, then Bankr deploy).

## Pool anatomy (meme + paired quote)

Bankr/Doppler launches on Robinhood Chain use a **two-asset pool**:

| Role | Also called | Example (DEVS pool) | Fee treatment |
|---|---|---|---|
| **Community / meme token** | base token | DEVS | Swapped → paired RWA, then Hub |
| **Paired quote / RWA** | quote token, numeraire | MSFT | Deposited to Hub **as-is** (no swap) |

Trading generates creator fees in **both assets**. When someone buys or sells DEVS against MSFT, the fee manager accrues a mix of DEVS and MSFT. Collection is always **split across both legs** — there is no “quote-only fee stream” once fees retarget to a SwapToSettlement router.

```text
Doppler pool (DEVS / MSFT)
        │
        ▼ collectFees(poolId)
   ┌────┴────┐
   │ Router  │
   └────┬────┘
        │
   ┌────┴────────────────────────────┐
   │                                 │
 MSFT leg                         DEVS leg
 (approved RWA)                   (meme)
   │                                 │
   ▼                                 ▼
 Hub deposit                  SwapToSettlement
 (direct)                     DEVS → MSFT via Doppler pool
                                    │
                                    ▼
                              Hub deposit (MSFT)
```

**Holdings for Bankr bot authors:**

- **Quoted / paired asset** = the tokenized stock or RWA on the other side of the pool (MSFT, NVDA, …). These are approved Hub assets when governance enables them. They never get swapped to SPY or to another RWA.
- **Meme / community token** = the launched community token (DEVS, …). These are **not** Hub assets by themselves; they must convert to the pool’s paired RWA before deposit.
- **SPY** = Hub’s default `settlementAsset` for *other* ecosystems — **not** the reward token for DEVS/MSFT. Never tell users “DEVS → SPY.” Always say “DEVS → **MSFT**” for that pool.
- **WETH-only pools** = **not eligible** for this skill. Require a stock/RWA quote leg.

### Manual fee claim vs holder sink

| Mode | Beneficiary | What user sees on “claim” |
|---|---|---|
| **Not in sink yet** | Creator wallet | Raw **DEVS + MSFT** in wallet (Doppler split) — **no auto-conversion** |
| **In sink** | Project Router | Keeper collects; MSFT → Hub; DEVS → swap → MSFT → Hub |

If a user says “when I claim I get DEVS and MSFT,” acknowledge that is normal **before** retarget. After sink setup, fees no longer land as raw tokens in their wallet.

### Three “claims” (do not mix up)

1. **Creator fee claim** — Doppler/Bankr UI → beneficiary wallet gets DEVS + MSFT
2. **Fee collect & route** — `ProjectRouter.collectAndRouteBankrDopplerFees` → keeper (not the bot)
3. **Holder dividend claim** — `UniversalRewardsHub.claim()` → holders receive MSFT after enrollment + round (no public UI yet)

The router has **collection/routing**, not holder **claim**. Holder claims live on the Hub.

### Router policies (what happens to the meme leg)

Set **once** at router creation — immutable:

| Policy | Meme fees (e.g. DEVS) | RWA fees (e.g. MSFT) | Use for holder sink? |
|---|---|---|---|
| **SwapToSettlement** (required) | Auto swap → paired RWA → Hub | Direct → Hub | **Yes** |
| **QuoteOnly** (legacy) | Sit on router (logged, not swapped) | Direct → Hub | **No** — create new router |
| Burn / Lock | Burned or locked | Direct → Hub | No |

### Bankr `quoteOnlyFees: true` vs router policy

These are **different knobs**:

- **`quoteOnlyFees` on Bankr deploy** — Doppler launch configuration passed to Bankr’s deploy API. Does not replace router policy.
- **`SwapToSettlement` on ProjectRouter** — Pay Me Dividends router policy. Required so the meme leg converts to paired RWA after collection.

For holder sink, always create a **SwapToSettlement** router regardless of the Bankr deploy flag.

### Keeper automation (not the bot)

After setup, the Pay Me Dividends **worker** hourly:

1. Calls `collectAndRouteBankrDopplerFees` on every SwapToSettlement router
2. MSFT (and any approved RWA received) → Hub immediately
3. DEVS balance → quotes **DEVS→MSFT** on the same Doppler V4 pool (via Doppler SDK + Robinhood Universal Router), then `processMemeAsset` deposits MSFT to Hub

Users and the Bankr bot **never sign swap transactions**. Governance pre-registers routes (e.g. DEVS→MSFT on the executor).

## Why Bankr bot owns identity

The website wizard cannot prove someone controls a token's fee recipient. Bankr can:

1. Resolve the authenticated user's wallet from their API key / Privy session
2. List tokens where that wallet earns beneficiary fees
3. Only offer sink enrollment for those tokens

## Bankr APIs to call

### 1. List eligible tokens for this wallet

```http
GET https://api.bankr.bot/public/doppler/beneficiary-fees/:walletAddress
```

No auth required. Returns every pool where the wallet holds a Doppler beneficiary share.

Filter for Pay Me Dividends eligibility:

| Field | Requirement |
|---|---|
| `chain` | `robinhood` (chain 4663) |
| `share` | ≥ 95% (parse `"95.00%"`) |
| Pair | One leg is the meme token; the other is an RWA/stock quote (e.g. `MSFT`), not `WETH` |

Example (DEVS):

```json
{
  "tokenAddress": "0x80db362eab104ec378e19d0a3dcd5e84bafd4ba3",
  "symbol": "DEVS",
  "chain": "robinhood",
  "poolId": "0x130caf8b43343e182a79a4046932bd5623a87e9309e7c53e2d1efb4ec6b8e2a0",
  "share": "95.00%",
  "token0Label": "DEVS",
  "token1Label": "MSFT"
}
```

Proxy (optional): `GET https://api.paymedividends.xyz/v1/bankr/beneficiary-fees/:walletAddress`

### 2. Confirm token details

```http
GET https://api.bankr.bot/token-launches/:tokenAddress
```

Returns `poolId`, `feeRecipient`, paired stock metadata.

## Fee routing (meme → paired RWA)

After fees retarget to the Project Router, **Pay Me Dividends runs an automated keeper** (not the Bankr bot) that hourly:

1. Collects the pool's Doppler fee share into the router
2. Deposits **RWA / quote fees** (e.g. MSFT) **directly** to the Universal Rewards Hub — no swap
3. Converts **meme fees** (e.g. DEVS) to the pool's **paired RWA** (DEVS → MSFT) via the token's Doppler V4 pool, then deposits MSFT to the Hub

Tokenized stocks are **never** swapped to SPY. SPY is unrelated to stock-paired pools like DEVS/MSFT.

The Bankr bot only guides router creation, fee retarget, and enrollment. It does **not** quote swaps or call `setRuntimeSwap`.

### 3. Onchain steps (user wallet on Robinhood Chain)

Bankr bot **guides** or **links** to the site; these txs are signed by the fee beneficiary wallet:

| Step | Action | Who |
|---|---|---|
| A | `ProjectRouterFactory.createPrelaunchRouter(hub, SwapToSettlement, lockbox=0, adapter=MemeToSettlementAdapter)` | Fee beneficiary |
| B | `FeeManager.updateBeneficiary(poolId, router)` | Fee beneficiary only |
| C | `router.bindBankrDopplerLaunch(...)` | Router `projectAdmin` |
| D | Keeper: `collectAndRouteBankrDopplerFees` → `setRuntimeSwap` → `processMemeAsset` | Pay Me Dividends worker (automatic) |

`MemeAssetPolicy.QuoteOnly` routers **cannot** be upgraded — always create a **new** router with `SwapToSettlement`. The site wizard uses the adapter configured on the API (`MEME_TO_PAIRED_ADAPTER`).

Platform constants (mainnet):

- Factory: `0x4AD615B99e2B6E8e2C322c657Ac8f81F1806A3a7`
- Hub: `0x6844D0814E904722777A48Ae2CF7C4b8F78a19e5`
- Fee manager: `0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544`
- MemeToSettlementAdapter (v2): `0x02f1eb8D7005367476d840B1aBe292c76Ec04CA4`
- MemeSwapExecutor (v2): `0xc87498E933d624e40E791322191ab03c7335057e`

Verify fee share: `getShares(poolId, router) >= 0.95e18`.

Governance must also register the meme → paired RWA route on the executor (`registerMemeRouteSimple`) and Hub prerequisites — see ops runbook. This is already done for DEVS/MSFT on mainnet.

### 4. Request Hub enrollment

After onchain verify (≥95% fee share to router):

```http
POST https://api.paymedividends.xyz/v1/enrollment-requests
Content-Type: application/json

{
  "tokenAddress": "0x80db362eab104ec378e19d0a3dcd5e84bafd4ba3",
  "router": "0x…new SwapToSettlement router…",
  "poolId": "0x130caf8b43343e182a79a4046932bd5623a87e9309e7c53e2d1efb4ec6b8e2a0",
  "feeBeneficiary": "0x374d91a5674fa7cf86e725093b5848b97e1e13b4",
  "tokenSymbol": "DEVS",
  "pairedStockSymbol": "MSFT",
  "requestedBy": "0x374d91a5674fa7cf86e725093b5848b97e1e13b4"
}
```

Governance reviews the queue (`GET /v1/enrollment-requests`) then calls `enrollMemberRouter` on the Safe.

### 5. Governance enrollment (off-bot)

After onchain verify, submit to Pay Me Dividends governance Safe:

- Token address, pool ID, router address, paired RWA symbol
- 30-day fee volume / claimable snapshot from `GET /token-launches/:token/fees?days=30`
- RWA ecosystem (e.g. MSFT pool vs META pool)

Governance calls `enrollMemberRouter(router, memberToken)` → 7-day public delay → `activateMemberRouter`.

## Conversation flow

```
User: Join the Pay Me Dividends holder sink

Bot:
  1. Resolve wallet W from Bankr session / API key
  2. GET /public/doppler/beneficiary-fees/W
  3. Filter robinhood + stock-paired + ≥95% share

  "You're the fee beneficiary on 2 Robinhood tokens eligible for the holder sink:

   1. DEVS / MSFT — 0x80db…4ba3
   2. TEST / NVDA — 0x…

   Which token should join the holder sink?"

User: DEVS

Bot:
  "DEVS fees currently go to your wallet. To join the sink we'll:
   • Create a SwapToSettlement holder router (meme fees auto-convert DEVS→MSFT via our keeper)
   • Retarget DEVS pool fees to that router
   • Verify onchain
   • Queue governance enrollment for the MSFT ecosystem pool

   MSFT trading fees deposit to the Hub directly. DEVS meme fees are swapped to MSFT
   automatically — you don't sign swap txs. Holders claim after governance enrolls the token.

   Open the wizard with your token pre-filled:
   https://app.paymedividends.xyz/#test-lab?token=0x80db…&join=sink

   Or I can walk you through each transaction."

  POST /v1/enrollment-requests after verify (same body as site wizard)
```

### If user mentions manual claim (DEVS + MSFT in wallet)

```
User: When I claim fees I get DEVS and MSFT — does DEVS become SPY?

Bot:
  "That's normal today: manual Doppler claims pay the fee split straight to your wallet —
   DEVS and MSFT, unchanged.

   Joining the holder sink retargets fees to a SwapToSettlement router instead of your wallet.
   After that, our keeper collects hourly:
   • MSFT fees → Hub (direct)
   • DEVS fees → swapped to MSFT on the DEVS/MSFT pool → Hub

   DEVS does **not** convert to SPY. Holders earn **MSFT** in the MSFT ecosystem pool.

   The router handles fee **collection/routing**, not holder **claims**. After governance
   enrolls DEVS and starts a round, holders claim MSFT from the Hub via Merkle proofs."
```

## What the bot must NOT do

- Create a router for a token where the user is **not** the current fee beneficiary
- Enroll in the Hub (governance-only)
- Store Bankr API keys server-side for the launch wizard (browser-only rule stays)
- Quote or execute meme→RWA swaps (the Pay Me Dividends keeper handles Doppler pool quotes)
- Route tokenized stocks through SPY
- Say manual wallet claims auto-convert DEVS to SPY or paired RWA (raw split until retarget)
- Confuse beneficiary fee claim (wallet) with holder Hub.claim (Merkle dividends)

## New token launches

For tokens not deployed yet, use the site **new token** path:

1. Create **SwapToSettlement** router on Robinhood Chain (site uses `MEME_TO_PAIRED_ADAPTER` from API config)
2. `POST /token-launches/deploy` with `feeRecipient: { type: "wallet", value: router }` and `quoteOnlyFees: true` (Bankr deploy flag — separate from router swap policy)
3. Verify fee share onchain
4. Submit enrollment request

`quoteOnlyFees: true` on Bankr deploy configures the Doppler launch; the Project Router still uses **SwapToSettlement** so meme fees convert to the paired RWA after collection.

Bankr skill can deep-link: `https://app.paymedividends.xyz/#test-lab`

## Product rules (fixed)

- **Holder pro-rata only** — no creator-fee wallet option at launch
- **Fee recipient at launch** = Project Router (holder sink)
- **Shared Hub** = governance-gated; per-RWA ecosystem pools with volume checks
- **Meme fees** → paired RWA (e.g. DEVS → MSFT), never SPY; **RWA fees** → Hub direct
