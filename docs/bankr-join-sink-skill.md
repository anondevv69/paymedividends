# Bankr skill: Join the Pay Me Dividends holder sink

Natural-language entry points:

- "Join the Pay Me Dividends holder sink"
- "Route my token fees to holders pro-rata"
- "I want my Bankr token in the shared RWA rewards pool"

This skill is for **existing Bankr tokens** where the user's wallet is already the **fee beneficiary**. New launches use [app.paymedividends.xyz](https://app.paymedividends.xyz) directly (router first, then Bankr deploy).

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

### 3. Onchain steps (user wallet on Robinhood Chain)

Bankr bot **guides** or **links** to the site; these txs are signed by the fee beneficiary wallet:

| Step | Action | Who |
|---|---|---|
| A | `ProjectRouterFactory.createPrelaunchRouter(hub, QuoteOnly, …)` | Fee beneficiary |
| B | `FeeManager.updateBeneficiary(poolId, router)` | Fee beneficiary only |
| C | `router.bindBankrDopplerLaunch(...)` | Router `projectAdmin` |
| D | `router.collectAndRouteBankrDopplerFees(0)` | Anyone (keeper) |

Platform constants (mainnet):

- Factory: `0x4AD615B99e2B6E8e2C322c657Ac8f81F1806A3a7`
- Hub: `0x6844D0814E904722777A48Ae2CF7C4b8F78a19e5`
- Fee manager: `0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544`

Verify fee share: `getShares(poolId, router) >= 0.95e18`.

### 4. Governance enrollment (off-bot)

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
   • Create a holder reward router (small gas)
   • Retarget DEVS pool fees to that router
   • Verify onchain
   • Queue governance enrollment for the MSFT ecosystem pool

   Open the wizard with your token pre-filled:
   https://app.paymedividends.xyz/#test-lab?token=0x80db…&join=sink

   Or I can walk you through each transaction."

  [Optional] POST enrollment intent to Pay Me Dividends API when available
```

## What the bot must NOT do

- Create a router for a token where the user is **not** the current fee beneficiary
- Enroll in the Hub (governance-only)
- Store Bankr API keys server-side for the launch wizard (browser-only rule stays)

## New token launches

For tokens not deployed yet, use the site **new token** path:

1. Create router on Robinhood Chain
2. `POST /token-launches/deploy` with `feeRecipient: { type: "wallet", value: router }` and `quoteOnlyFees: true`
3. Verify fee share onchain

Bankr skill can deep-link: `https://app.paymedividends.xyz/#test-lab`

## Product rules (fixed)

- **Holder pro-rata only** — no creator-fee wallet option at launch
- **Fee recipient at launch** = Project Router (holder sink)
- **Shared Hub** = governance-gated; per-RWA ecosystem pools with volume checks
