---
name: join-holder-sink
description: Join the Pay Me Dividends holder sink for existing Bankr tokens on Robinhood Chain. List fee-beneficiary tokens, create a SwapToSettlement Project Router, retarget Doppler fees, verify onchain, and queue Hub enrollment. Meme fees auto-convert to paired RWA via the Pay Me Dividends keeper (not the bot). New launches use app.paymedividends.xyz instead.
metadata:
  {
    "clawdbot":
      {
        "emoji": "💸",
        "homepage": "https://app.paymedividends.xyz",
      },
  }
---

# Join the Pay Me Dividends holder sink

Route an **existing** Bankr token's trading fees to holders pro-rata via a Project Router and the shared RWA Hub.

Natural-language triggers:

- "Join the Pay Me Dividends holder sink"
- "Route my token fees to holders pro-rata"
- "I want my Bankr token in the shared RWA rewards pool"

**New token launches** are not this skill — send users to [app.paymedividends.xyz](https://app.paymedividends.xyz) (router + Bankr deploy with API key in browser).

## Pool anatomy (meme + paired quote)

Every eligible Bankr token sits in a **two-leg Doppler pool**:

| Leg | Names | Example | What happens to fees |
|---|---|---|---|
| Community token | base, meme | DEVS | Converted to paired RWA → Hub |
| Paired quote | quote, numeraire, RWA | MSFT | Deposited to Hub unchanged |

Fees accrue in **both** assets when traders swap. The router receives a **split** on each collection — not quote-only.

```
Pool DEVS/MSFT  →  collect  →  Router
                                  ├─ MSFT  → Hub (direct)
                                  └─ DEVS  → swap → MSFT → Hub
```

- **Quoted token** = paired RWA/stock (MSFT). Approved by governance. Never swapped to SPY.
- **Meme token** = community token (DEVS). Swapped to paired RWA only.
- **SPY** = unrelated settlement asset for other Hub pools; not used for DEVS/MSFT rewards.
- **WETH pairs** = ineligible for this skill.

### Router policy (immutable)

| Policy | Meme leg | RWA leg | Holder sink? |
|---|---|---|---|
| SwapToSettlement | Swap → paired RWA | Direct Hub | **Yes** |
| QuoteOnly | Stuck on router | Direct Hub | **No** — new router |

Bankr deploy `quoteOnlyFees: true` ≠ router policy. Always use **SwapToSettlement** router from the site wizard.

Keeper (Pay Me Dividends worker) runs collect + Doppler swap + Hub deposit hourly. **Bot does not swap.**

## Who can use this

Only the wallet that is the **current Doppler fee beneficiary** for the token (≥95% share). Bankr resolves the user's wallet from their session/API key — never offer sink setup for tokens where they are not the beneficiary.

## Fee routing (after retarget)

| Fee leg | Example | Path |
|---|---|---|
| RWA / quote | MSFT | Router → Hub (direct, no swap) |
| Meme | DEVS | Router → adapter → keeper swaps DEVS→MSFT via Doppler pool → Hub |

The **Pay Me Dividends keeper** (hourly worker) handles collection and meme→paired-RWA conversion. The Bankr bot does **not** swap tokens and never routes through SPY.

## Flow

1. Resolve wallet `W` from Bankr auth
2. `GET https://api.bankr.bot/public/doppler/beneficiary-fees/W`
3. Filter: `chain === "robinhood"`, share ≥ 95%, paired with an RWA/stock quote (not WETH-only)
4. User picks a token
5. On Robinhood Chain (4663):
   - Create router: `ProjectRouterFactory.createPrelaunchRouter(hub, SwapToSettlement, 0, MemeToSettlementAdapter)` — site wizard does this when API has `MEME_TO_PAIRED_ADAPTER` configured
   - Retarget fees: `POST https://api.bankr.bot/public/doppler/build-transfer-beneficiary` → sign `updateBeneficiary`
   - Bind launch: `router.bindBankrDopplerLaunch(...)` from `projectAdmin`
   - Verify: `getShares(poolId, router) >= 0.95e18`
6. `POST https://api.paymedividends.xyz/v1/enrollment-requests` (or site wizard)
7. Governance Safe calls `enrollMemberRouter` → 7-day delay → `activateMemberRouter`

**Do not** reuse old QuoteOnly routers — policy is immutable; create a new SwapToSettlement router and retarget fees.

Deep link (existing token): `https://app.paymedividends.xyz/#test-lab?token=0x…`

## Platform constants (Robinhood mainnet)

| Contract | Address |
|---|---|
| ProjectRouterFactory | `0x4AD615B99e2B6E8e2C322c657Ac8f81F1806A3a7` |
| UniversalRewardsHub | `0x6844D0814E904722777A48Ae2CF7C4b8F78a19e5` |
| Fee manager | `0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544` |
| MemeToSettlementAdapter | `0x02f1eb8D7005367476d840B1aBe292c76Ec04CA4` |
| MemeSwapExecutor | `0xc87498E933d624e40E791322191ab03c7335057e` |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |

## APIs

See [references/api.md](references/api.md) for request/response details.

Proxy (optional): `GET /v1/bankr/beneficiary-fees/:wallet` on Pay Me Dividends API filters Robinhood stock-paired tokens.

## Must NOT do

- Router setup for non-beneficiary wallets
- Hub enrollment onchain (governance Safe only)
- Store user Bankr API keys server-side for the launch wizard
- Quote or execute swaps (keeper handles Doppler DEVS→MSFT conversion)
- Route RWAs through SPY or mention 0x to users for fee conversion

## Product rules

- Holder pro-rata only — no creator-fee wallet at launch
- Fee recipient = Project Router (holder sink)
- Shared Hub is governance-gated per RWA ecosystem pool
- Meme fees → paired RWA; RWA fees → Hub direct
