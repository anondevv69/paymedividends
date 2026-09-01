const ROBINSCAN_API = "https://robinscan.io/api/tokens";

export async function fetchRobinscanHolders(tokenAddress, fetchImpl = fetch, { maxPages = 50 } = {}) {
  const token = tokenAddress.toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(token)) throw new Error("invalid_token_address");

  const holders = [];
  let total = null;

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await fetchImpl(`${ROBINSCAN_API}/${token}/holders?page=${page}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`robinscan_holders_${response.status}`);

    const payload = await response.json();
    if (payload.status && payload.status !== "ok") throw new Error("robinscan_holders_failed");
    if (total == null) total = payload.total ?? null;

    for (const item of payload.items ?? []) {
      holders.push({
        account: String(item.holder).toLowerCase(),
        balance: BigInt(item.balance ?? 0),
        label: item.holderName ?? null,
        share: item.share ?? null,
      });
    }

    if (!payload.items?.length) break;
    if (total != null && holders.length >= total) break;
  }

  return { totalCount: total ?? holders.length, holders };
}

export async function fetchRobinscanHolderCount(tokenAddress, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(
      `${ROBINSCAN_API}/${tokenAddress.toLowerCase()}/holders?page=1`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) return null;
    const payload = await response.json();
    return payload.total ?? payload.items?.length ?? null;
  } catch {
    return null;
  }
}
