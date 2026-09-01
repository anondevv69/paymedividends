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
