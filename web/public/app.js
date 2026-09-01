const DEFAULTS = {
  chainId: 4663,
  chainHex: "0x1237",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
  factory: "0x4AD615B99e2B6E8e2C322c657Ac8f81F1806A3a7",
  hub: "0x6844D0814E904722777A48Ae2CF7C4b8F78a19e5",
};

const BANKR_DEPLOY_API = "https://api.bankr.bot/token-launches/deploy";
const BANKR_LAUNCH_API = "https://api.bankr.bot/token-launches";
const ROBINHOOD_FEE_MANAGER = "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544";
const MIN_FEE_SHARE = 950000000000000000n; // 0.95e18
const GET_SHARES_SELECTOR = "0x5ebb58fb";

const state = {
  connectedAccount: null,
  programType: "newBankr",
  platform: { ...DEFAULTS },
  lastRouter: null,
  lastLaunch: null,
  bankrLookup: null,
  pairedStocks: [],
  pairedStockByLabel: new Map(),
  busy: false,
  wizardStep: "ready",
};

const form = document.querySelector("#program-form");
const programChoices = [...document.querySelectorAll('input[name="programType"]')];
const walletButton = document.querySelector("#wallet-button");
const output = document.querySelector("#blueprint-output");
const createButton = document.querySelector("#create-router-button");
const bankrLaunchFields = document.querySelector("#bankr-launch-fields");
const existingTokenFields = document.querySelector("#existing-token-fields");
const bankrVerifyFields = document.querySelector("#bankr-verify-fields");
const simulateCheckbox = document.querySelector("#simulate-launch");

function selectLabel(input) {
  const group = [...document.querySelectorAll(`input[name="${input.name}"]`)];
  group.forEach((item) => item.closest(".choice")?.classList.toggle("selected", item.checked));
}

function shortAddress(address) {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function value(id) {
  return document.querySelector(`#${id}`)?.value.trim() ?? "";
}

function isAddress(valueText) {
  return /^0x[a-fA-F0-9]{40}$/.test(valueText);
}

function setWizardStep(step, label) {
  state.wizardStep = step;
  const badge = document.querySelector("#blueprint-state");
  if (badge) badge.textContent = label ?? step;
  const order = ["ready", "wallet", "router", "launch", "verify", "verified"];
  const stepIndex = order.indexOf(step);
  document.querySelectorAll("[data-wizard-step]").forEach((node) => {
    const nodeIndex = order.indexOf(node.dataset.wizardStep);
    node.classList.toggle("wizard-step-active", node.dataset.wizardStep === step);
    node.classList.toggle("wizard-step-done", stepIndex > nodeIndex && nodeIndex >= 0);
  });
}

function displayPath() {
  return state.programType === "newBankr"
    ? "Launch with shared rewards"
    : "Existing token → shared Hub";
}

function pad32(hex) {
  return hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

function encodeCreateRouterCalldata(hub) {
  return `0xe1ad62bd${pad32(hub)}${pad32("0")}${pad32("0")}${pad32("0")}`;
}

function encodeGetSharesCalldata(poolId, beneficiary) {
  return `${GET_SHARES_SELECTOR}${pad32(poolId)}${pad32(beneficiary)}`;
}

function topicAddress(topic) {
  return `0x${topic.slice(-40)}`;
}

function normalizePoolId(poolId) {
  const hex = poolId.replace(/^0x/, "").toLowerCase();
  if (hex.length !== 64) throw new Error("Pool ID must be a 32-byte hex value.");
  return `0x${hex}`;
}

function refreshPreview() {
  const token = value("token-symbol") || value("token-name") || value("existing-token-address").slice(0, 6) || "TOKEN";
  document.querySelector("#blueprint-token").textContent = `$${token.toUpperCase()} community`;
  document.querySelector("#detail-program").textContent = displayPath();
  if (!state.lastRouter) {
    document.querySelector("#blueprint-vault").textContent =
      state.programType === "newBankr" ? "Router + Bankr launch" : "Router for existing token";
  }

  const isNew = state.programType === "newBankr";
  bankrLaunchFields?.classList.toggle("hidden", !isNew);
  existingTokenFields?.classList.toggle("hidden", isNew);
  bankrVerifyFields?.classList.toggle("hidden", isNew && !state.lastLaunch);
  createButton.textContent = isNew
    ? "Launch with shared holder rewards →"
    : "Create router + verify token →";
}

async function connectWallet() {
  if (!window.ethereum) {
    walletButton.textContent = "Wallet not found";
    output.textContent = "Install a browser wallet on Robinhood Chain, then try again.";
    return null;
  }
  const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
  state.connectedAccount = account;
  walletButton.innerHTML = `${shortAddress(account)} <span>●</span>`;
  return account;
}

async function ensureRobinhoodChain() {
  const current = await window.ethereum.request({ method: "eth_chainId" });
  if (Number.parseInt(current, 16) === state.platform.chainId) return;
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: state.platform.chainHex }],
    });
  } catch (error) {
    if (error?.code !== 4902) throw error;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: state.platform.chainHex,
        chainName: "Robinhood Chain",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [state.platform.rpcUrl],
        blockExplorerUrls: [state.platform.explorer],
      }],
    });
  }
}

async function waitForReceipt(txHash) {
  for (let i = 0; i < 60; i += 1) {
    const receipt = await window.ethereum.request({
      method: "eth_getTransactionReceipt",
      params: [txHash],
    });
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Timed out waiting for the create-router transaction.");
}

function routerFromReceipt(receipt) {
  const created = receipt.logs?.find((log) =>
    log.address?.toLowerCase() === state.platform.factory.toLowerCase() && log.topics?.length >= 3
  );
  if (created) return topicAddress(created.topics[2]);
  throw new Error("Router was created, but the address could not be read from the receipt.");
}

function showRouter(router, txHash) {
  state.lastRouter = router;
  const result = document.querySelector("#router-result");
  const addressEl = document.querySelector("#router-address");
  const explorer = document.querySelector("#router-explorer");
  result.classList.remove("hidden");
  addressEl.textContent = router;
  explorer.href = `${state.platform.explorer}/address/${router}`;
  document.querySelector("#blueprint-vault").textContent = shortAddress(router);
  document.querySelector("#blueprint-source").textContent = "Bankr fee recipient";
  if (txHash) {
    output.textContent =
      `Router ready at ${router}. Tx ${shortAddress(txHash)}. Your wallet is the router admin.`;
  }
}

function setReadout(id, lines, tone = "") {
  const readout = document.querySelector(`#${id}`);
  if (!readout) return;
  readout.classList.remove("hidden", "verify-pass", "verify-fail");
  if (tone) readout.classList.add(tone);
  readout.innerHTML = lines.map((line) => `<p>${line}</p>`).join("");
}

function applyBankrLookup(lookup) {
  state.bankrLookup = lookup;
  state.lastLaunch = {
    tokenAddress: lookup.tokenAddress,
    poolId: lookup.poolId,
    feeDistribution: lookup.feeRecipientAddress
      ? { creator: { address: lookup.feeRecipientAddress } }
      : undefined,
  };

  const poolEl = document.querySelector("#resolved-pool-id");
  if (poolEl) poolEl.textContent = lookup.poolId ?? "—";

  const lines = [
    `${lookup.tokenSymbol} — ${lookup.tokenName}`,
    `Pool ID: ${lookup.poolId}`,
    `Current Bankr fee recipient: ${lookup.feeRecipientAddress ?? "unknown"}`,
  ];
  if (lookup.pairedStockSymbol) {
    lines.push(`Paired stock: ${lookup.pairedStockSymbol}`);
  }
  setReadout("token-lookup-readout", lines);

  const tokenLink = document.querySelector("#existing-token-link");
  if (tokenLink && lookup.tokenAddress) {
    tokenLink.href = `${state.platform.explorer}/address/${lookup.tokenAddress}`;
    tokenLink.classList.remove("hidden");
  }
}

function showLaunchResult(launch) {
  state.lastLaunch = launch;
  bankrVerifyFields?.classList.remove("hidden");
  document.querySelector("#launch-result")?.classList.remove("hidden");

  const set = (id, text) => {
    const el = document.querySelector(`#${id}`);
    if (el) el.textContent = text ?? "—";
  };

  set("launch-token", launch.tokenAddress);
  set("launch-pool", launch.poolId);
  set("launch-tx", launch.txHash ? shortAddress(launch.txHash) : "Simulated (no tx)");
  set("resolved-pool-id", launch.poolId ?? "—");

  const tokenLink = document.querySelector("#launch-token-link");
  const txLink = document.querySelector("#launch-tx-link");
  if (tokenLink && launch.tokenAddress) {
    tokenLink.href = `${state.platform.explorer}/address/${launch.tokenAddress}`;
  }
  if (txLink && launch.txHash) {
    txLink.href = `${state.platform.explorer}/tx/${launch.txHash}`;
    txLink.classList.remove("hidden");
  } else {
    txLink?.classList.add("hidden");
  }
}

function bankrErrorMessage(payload, status) {
  if (typeof payload === "string") return payload;
  return payload?.message || payload?.error || payload?.details || `Bankr request failed (${status}).`;
}

async function lookupBankrToken(tokenAddress) {
  const normalized = tokenAddress.toLowerCase();
  const response = await fetch(`${BANKR_LAUNCH_API}/${normalized}`, {
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(bankrErrorMessage(payload, response.status));
  }

  const launch = payload.launch ?? payload;
  if (!launch?.poolId) {
    throw new Error("Bankr found the token but did not return a pool ID.");
  }

  const lookup = {
    tokenAddress: launch.tokenAddress ?? tokenAddress,
    tokenName: launch.tokenName ?? "Unknown token",
    tokenSymbol: launch.tokenSymbol ?? shortAddress(tokenAddress),
    poolId: launch.poolId,
    feeRecipientAddress: launch.feeRecipient?.walletAddress ?? launch.feeRecipient?.address,
    pairedStockSymbol: launch.pairedStock?.symbol,
    chain: launch.chain,
  };

  applyBankrLookup(lookup);
  return lookup;
}

async function createRouterOnchain(account) {
  setWizardStep("router", "Creating router");
  output.textContent = "Confirm the create-router transaction in your wallet…";

  const data = encodeCreateRouterCalldata(state.platform.hub);
  const txHash = await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from: account, to: state.platform.factory, data }],
  });

  output.textContent = `Router tx submitted ${shortAddress(txHash)}. Waiting for confirmation…`;
  const receipt = await waitForReceipt(txHash);
  if (Number.parseInt(receipt.status, 16) !== 1) {
    throw new Error("Create-router transaction failed onchain.");
  }
  const router = routerFromReceipt(receipt);
  showRouter(router, txHash);
  return router;
}

function resolvePairedStockAddress() {
  const search = value("paired-stock-search");
  if (!search) return "";
  const direct = state.pairedStockByLabel.get(search);
  if (direct) return direct;
  const bySymbol = state.pairedStocks.find(
    (stock) => stock.symbol.toLowerCase() === search.toLowerCase(),
  );
  return bySymbol?.address ?? "";
}

function buildBankrPayload(router, simulateOnly) {
  const tokenName = value("token-name");
  const tokenSymbol = value("token-symbol").toUpperCase();
  if (!tokenName) throw new Error("Token name is required.");
  if (!tokenSymbol) throw new Error("Token symbol is required.");

  const payload = {
    tokenName,
    tokenSymbol,
    chain: "robinhood",
    quoteOnlyFees: true,
    feeRecipient: { type: "wallet", value: router },
    simulateOnly,
  };

  const pairedStock = resolvePairedStockAddress();
  if (pairedStock) payload.pairedStockAddress = pairedStock;
  return payload;
}

async function launchOnBankr(router, apiKey, simulateOnly) {
  setWizardStep("launch", simulateOnly ? "Simulating launch" : "Launching on Bankr");
  output.textContent = simulateOnly
    ? "Calling Bankr simulateOnly… your API key stays in this browser."
    : "Calling Bankr deploy… confirm this is the launch you want. Your API key stays in this browser.";

  const response = await fetch(BANKR_DEPLOY_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(buildBankrPayload(router, simulateOnly)),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(bankrErrorMessage(payload, response.status));
  }

  const launch = {
    tokenAddress: payload.tokenAddress,
    poolId: payload.poolId,
    txHash: payload.txHash,
    feeDistribution: payload.feeDistribution,
    simulated: simulateOnly,
  };

  if (!launch.tokenAddress || !launch.poolId) {
    throw new Error("Bankr responded without a token address or pool ID.");
  }

  showLaunchResult(launch);
  return launch;
}

async function readFeeShare(poolId, beneficiary) {
  const data = encodeGetSharesCalldata(normalizePoolId(poolId), beneficiary);
  const raw = await window.ethereum.request({
    method: "eth_call",
    params: [{ to: ROBINHOOD_FEE_MANAGER, data }, "latest"],
  });
  if (!raw || raw === "0x") return 0n;
  return BigInt(raw);
}

function renderVerification({ shares, router, feeRecipientAddress, simulated, tokenSymbol }) {
  const verified = shares >= MIN_FEE_SHARE;
  const recipientMatches = feeRecipientAddress?.toLowerCase() === router.toLowerCase();
  const sharePct = Number(shares) / 1e16 / 100;

  const lines = [
    verified
      ? "Verified — this router receives at least 95% of pool fees."
      : "Not verified yet — fees are not pointed at this router.",
    `Onchain fee share: ${sharePct.toFixed(2)}%`,
  ];

  if (tokenSymbol) lines.unshift(`${tokenSymbol} pool checked.`);

  if (feeRecipientAddress) {
    lines.push(
      recipientMatches
        ? "Bankr fee recipient matches this router."
        : `Bankr fee recipient is still ${shortAddress(feeRecipientAddress)}. Point fees to your router, then verify again.`,
    );
  }

  if (simulated) {
    lines.push("This was a simulation only. Run a live launch to deploy the token.");
  } else if (verified) {
    lines.push("Next: governance binds this pool and enrolls the router in the shared Hub.");
  } else if (state.programType === "existingBankr") {
    lines.push("Use Bankr or Doppler updateBeneficiary to send fees to your new router.");
  } else {
    lines.push("Check Bankr fee recipient settings, then verify again.");
  }

  setReadout("fee-verify-readout", lines, verified ? "verify-pass" : "verify-fail");
  setWizardStep(verified ? "verified" : "verify", verified ? "Fees verified" : "Verify fees");
  output.textContent = verified
    ? "Fee recipient verified onchain."
    : "Token found, but onchain fee share is below 95% for this router.";
}

async function verifyFeeRecipient({ poolId, router, feeRecipientAddress, simulated, tokenSymbol }) {
  setWizardStep("verify", "Verifying fees");
  output.textContent = "Reading Doppler fee shares on Robinhood Chain…";
  bankrVerifyFields?.classList.remove("hidden");

  const shares = await readFeeShare(poolId, router);
  renderVerification({ shares, router, feeRecipientAddress, simulated, tokenSymbol });
  return shares >= MIN_FEE_SHARE;
}

async function runNewLaunchFlow(event) {
  event.preventDefault();
  if (state.busy) return;
  if (!state.platform.factory || !state.platform.hub) {
    output.textContent = "Factory/Hub addresses are not configured on the API yet.";
    return;
  }

  const apiKey = value("bankr-api-key");
  if (!apiKey.startsWith("bk_")) {
    output.textContent = "Paste your Bankr user API key (starts with bk_). It never leaves this browser.";
    return;
  }

  const simulateOnly = simulateCheckbox?.checked ?? false;
  state.busy = true;
  createButton.disabled = true;
  setWizardStep("wallet", "Connect wallet");

  try {
    const account = state.connectedAccount ?? await connectWallet();
    if (!account) return;
    await ensureRobinhoodChain();

    const router = await createRouterOnchain(account);
    const launch = await launchOnBankr(router, apiKey, simulateOnly);

    if (!simulateOnly) {
      await verifyFeeRecipient({
        poolId: launch.poolId,
        router,
        feeRecipientAddress: launch.feeDistribution?.creator?.address,
        simulated: false,
        tokenSymbol: value("token-symbol"),
      });
    } else {
      output.textContent =
        `Simulation OK. Token would deploy to ${launch.tokenAddress}. ` +
        "Uncheck dry run and submit again for a live launch.";
      setWizardStep("launch", "Simulated");
    }
  } catch (error) {
    setWizardStep("error", "Needs attention");
    output.textContent = error?.message
      ? `Launch flow stopped: ${error.message}`
      : "Launch flow stopped. The wallet or Bankr request may have been rejected.";
  } finally {
    state.busy = false;
    createButton.disabled = false;
  }
}

async function runExistingFlow(event) {
  event.preventDefault();
  if (state.busy) return;
  if (!state.platform.factory || !state.platform.hub) {
    output.textContent = "Factory/Hub addresses are not configured on the API yet.";
    return;
  }

  const tokenAddress = value("existing-token-address");
  if (!isAddress(tokenAddress)) {
    output.textContent = "Paste the existing Bankr token contract address (0x…).";
    return;
  }

  state.busy = true;
  createButton.disabled = true;
  setWizardStep("wallet", "Connect wallet");

  try {
    const account = state.connectedAccount ?? await connectWallet();
    if (!account) return;
    await ensureRobinhoodChain();

    output.textContent = "Looking up token on Bankr…";
    const lookup = await lookupBankrToken(tokenAddress);
    bankrVerifyFields?.classList.remove("hidden");

    const router = await createRouterOnchain(account);
    await verifyFeeRecipient({
      poolId: lookup.poolId,
      router,
      feeRecipientAddress: lookup.feeRecipientAddress,
      simulated: false,
      tokenSymbol: lookup.tokenSymbol,
    });
  } catch (error) {
    setWizardStep("error", "Needs attention");
    output.textContent = error?.message
      ? `Could not finish setup: ${error.message}`
      : "Could not finish setup. The wallet may have rejected the request.";
  } finally {
    state.busy = false;
    createButton.disabled = false;
  }
}

async function lookupExistingToken(event) {
  event.preventDefault();
  const tokenAddress = value("existing-token-address");
  if (!isAddress(tokenAddress)) {
    output.textContent = "Paste a valid token address (0x…).";
    return;
  }

  try {
    output.textContent = "Looking up token on Bankr…";
    const lookup = await lookupBankrToken(tokenAddress);
    bankrVerifyFields?.classList.remove("hidden");
    output.textContent =
      `Found ${lookup.tokenSymbol} on Bankr. Current fee recipient: ${shortAddress(lookup.feeRecipientAddress)}.`;

    if (state.lastRouter) {
      await connectWallet();
      await ensureRobinhoodChain();
      await verifyFeeRecipient({
        poolId: lookup.poolId,
        router: state.lastRouter,
        feeRecipientAddress: lookup.feeRecipientAddress,
        simulated: false,
        tokenSymbol: lookup.tokenSymbol,
      });
    }
  } catch (error) {
    output.textContent = error?.message ? `Lookup failed: ${error.message}` : "Lookup failed.";
  }
}

async function verifyExistingFees(event) {
  event.preventDefault();
  if (!state.lastRouter) {
    output.textContent = "Create a router first.";
    return;
  }

  try {
    let lookup = state.bankrLookup;
    const tokenAddress = value("existing-token-address");
    if (tokenAddress && isAddress(tokenAddress)) {
      lookup = await lookupBankrToken(tokenAddress);
    }
    if (!lookup?.poolId) {
      output.textContent = "Look up a Bankr token address first.";
      return;
    }

    await connectWallet();
    await ensureRobinhoodChain();
    await verifyFeeRecipient({
      poolId: lookup.poolId,
      router: state.lastRouter,
      feeRecipientAddress: lookup.feeRecipientAddress,
      simulated: false,
      tokenSymbol: lookup.tokenSymbol,
    });
  } catch (error) {
    output.textContent = error?.message ? `Verification failed: ${error.message}` : "Verification failed.";
  }
}

async function loadApiStatus() {
  const status = document.querySelector("#api-status");
  try {
    const response = await fetch(`${window.PAYMENTS_API_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("unhealthy");
    status.textContent = "Online";
  } catch {
    status.textContent = "Offline";
  }
}

async function loadPlatform() {
  const factoryEl = document.querySelector("#detail-factory");
  const hubEl = document.querySelector("#detail-hub");
  try {
    const response = await fetch(`${window.PAYMENTS_API_URL}/v1/platform`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("unavailable");
    const data = await response.json();
    state.platform = {
      chainId: data.chainId ?? DEFAULTS.chainId,
      chainHex: `0x${Number(data.chainId ?? DEFAULTS.chainId).toString(16)}`,
      rpcUrl: data.rpcUrl ?? DEFAULTS.rpcUrl,
      explorer: DEFAULTS.explorer,
      factory: data.projectRouterFactory || DEFAULTS.factory,
      hub: data.universalRewardsHub || DEFAULTS.hub,
    };
    factoryEl.textContent = shortAddress(state.platform.factory);
    hubEl.textContent = shortAddress(state.platform.hub);
    document.querySelector("#contracts-live").textContent =
      data.phase === "contracts_live" || (state.platform.factory && state.platform.hub) ? "Live" : "Pending";
    document.querySelector("#setup-mode").textContent =
      data.phase === "contracts_live" ? "Robinhood live" : "Awaiting API config";
  } catch {
    factoryEl.textContent = shortAddress(DEFAULTS.factory);
    hubEl.textContent = shortAddress(DEFAULTS.hub);
    state.platform = { ...DEFAULTS, chainHex: DEFAULTS.chainHex };
  }
}

function renderContributors(contributors) {
  const list = document.querySelector("#contributor-list");
  list.replaceChildren();
  if (!contributors.length) {
    const empty = document.createElement("div");
    empty.className = "empty-contributors";
    const title = document.createElement("span");
    title.textContent = "NO VERIFIED MEMBER TOKENS YET";
    const copy = document.createElement("p");
    copy.textContent =
      "Launch through this wizard or point Bankr fees to a router, then wait for Safe enrollment.";
    empty.append(title, copy);
    list.append(empty);
    return;
  }

  contributors.forEach((contributor) => {
    const row = document.createElement("div");
    row.className = "contributor-row";
    const token = document.createElement("strong");
    token.textContent = contributor.symbol ?? contributor.tokenAddress;
    const detail = document.createElement("span");
    detail.textContent = contributor.tokenAddress;
    const status = document.createElement("em");
    status.textContent = "Verified member router";
    row.append(token, detail, status);
    list.append(row);
  });
}

async function loadUniversalDirectory() {
  const phase = document.querySelector("#universal-phase");
  const vault = document.querySelector("#universal-vault");
  const verification = document.querySelector("#universal-verification");
  const count = document.querySelector("#universal-count");
  try {
    const response = await fetch(`${window.PAYMENTS_API_URL}/v1/universal`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("unavailable");
    const data = await response.json();
    phase.textContent = data.phase === "not_deployed" ? "Awaiting Hub" : "Hub live";
    vault.textContent = data.universalRewardsHub ?? state.platform.hub;
    verification.textContent = data.verification;
    count.textContent = String(data.verifiedContributorCount ?? 0);
    renderContributors(data.contributors ?? []);
  } catch {
    phase.textContent = "Directory offline";
    vault.textContent = state.platform.hub;
    verification.textContent = "API offline. Defaults still allow launches from this page.";
  }
}

async function loadPairedStocks() {
  const datalist = document.querySelector("#paired-stock-list");
  const status = document.querySelector("#paired-stock-status");
  if (!datalist) return;

  try {
    const response = await fetch(`${window.PAYMENTS_API_URL}/v1/bankr/paired-stocks`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error("Stock registry unavailable");
    const data = await response.json();
    const stocks = data.items ?? [];

    state.pairedStocks = stocks;
    state.pairedStockByLabel.clear();
    datalist.replaceChildren();

    stocks.forEach((stock) => {
      const label = `${stock.symbol} — ${stock.name}`;
      state.pairedStockByLabel.set(label, stock.address);
      const option = document.createElement("option");
      option.value = label;
      datalist.append(option);
    });

    if (status) {
      status.textContent =
        `${stocks.length} Bankr-compatible Robinhood stocks loaded (official registry). Leave blank for the default quote pool.`;
    }
  } catch {
    if (status) {
      status.textContent =
        "Could not load the Bankr stock registry. You can still launch without a stock pair.";
    }
  }
}

programChoices.forEach((input) => input.addEventListener("change", () => {
  selectLabel(input);
  state.programType = input.value;
  refreshPreview();
}));
form.querySelectorAll("input, select, textarea").forEach((input) => input.addEventListener("input", refreshPreview));
walletButton.addEventListener("click", () => {
  connectWallet().catch(() => {
    output.textContent = "Wallet connection was not approved.";
  });
});
form.addEventListener("submit", (event) => {
  if (state.programType === "newBankr") runNewLaunchFlow(event);
  else runExistingFlow(event);
});
document.querySelector("#copy-router")?.addEventListener("click", async () => {
  if (!state.lastRouter) return;
  await navigator.clipboard.writeText(state.lastRouter);
  output.textContent = `Copied ${state.lastRouter}.`;
});
document.querySelector("#lookup-token-button")?.addEventListener("click", lookupExistingToken);
document.querySelector("#verify-fees-button")?.addEventListener("click", verifyExistingFees);

refreshPreview();
setWizardStep("ready", "Ready");
loadApiStatus();
loadPlatform().then(loadUniversalDirectory);
loadPairedStocks();
