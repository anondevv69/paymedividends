const DEFAULTS = {
  chainId: 4663,
  chainHex: "0x1237",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
  factory: "0x4AD615B99e2B6E8e2C322c657Ac8f81F1806A3a7",
  hub: "0x6844D0814E904722777A48Ae2CF7C4b8F78a19e5",
};

const BANKR_API = "https://api.bankr.bot/token-launches/deploy";
const ROBINHOOD_FEE_MANAGER = "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544";
const MIN_FEE_SHARE = 950000000000000000n; // 0.95e18
const GET_SHARES_SELECTOR = "0x5ebb58fb";

const PAIRED_STOCKS = [
  { label: "Default pool quote (no stock pair)", value: "" },
  { label: "MSFT — Microsoft", value: "0xe93237C50D904957Cf27E7B1133b510C669c2e74" },
  { label: "SPY — S&P 500 ETF", value: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C" },
];

const state = {
  connectedAccount: null,
  programType: "newBankr",
  platform: { ...DEFAULTS },
  lastRouter: null,
  lastLaunch: null,
  busy: false,
  wizardStep: "ready",
};

const form = document.querySelector("#program-form");
const programChoices = [...document.querySelectorAll('input[name="programType"]')];
const walletButton = document.querySelector("#wallet-button");
const output = document.querySelector("#blueprint-output");
const createButton = document.querySelector("#create-router-button");
const bankrLaunchFields = document.querySelector("#bankr-launch-fields");
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
  if (state.programType === "universal") return "Join shared RWA index";
  return state.programType === "newBankr" ? "Launch with shared rewards" : "Retarget an existing token";
}

function pad32(hex) {
  return hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

function encodeCreateRouterCalldata(hub) {
  return `0xe1ad62bd${pad32(hub)}${pad32("0")}${pad32("0")}${pad32("0")}`;
}

function encodeGetSharesCalldata(poolId, beneficiary) {
  const pool = pad32(poolId);
  const addr = pad32(beneficiary);
  return `${GET_SHARES_SELECTOR}${pool}${addr}`;
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
  const token = value("token-symbol") || value("token-name") || "TEST";
  document.querySelector("#blueprint-token").textContent = `$${token.toUpperCase()} community`;
  document.querySelector("#detail-program").textContent = displayPath();
  if (!state.lastRouter) {
    document.querySelector("#blueprint-vault").textContent = "Router + Bankr launch";
  }

  const isNew = state.programType === "newBankr";
  bankrLaunchFields?.classList.toggle("hidden", !isNew);
  bankrVerifyFields?.classList.toggle("hidden", isNew && !state.lastLaunch);
  createButton.textContent = isNew ? "Launch with shared holder rewards →" : "Create router & verify fees →";
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

function showLaunchResult(launch) {
  state.lastLaunch = launch;
  bankrVerifyFields?.classList.remove("hidden");
  const panel = document.querySelector("#launch-result");
  panel?.classList.remove("hidden");

  const set = (id, text) => {
    const el = document.querySelector(`#${id}`);
    if (el) el.textContent = text ?? "—";
  };

  set("launch-token", launch.tokenAddress);
  set("launch-pool", launch.poolId);
  set("launch-tx", launch.txHash ? shortAddress(launch.txHash) : "Simulated (no tx)");
  set("verify-pool-id", launch.poolId ?? "");

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

  const pairedStock = value("paired-stock");
  if (pairedStock) payload.pairedStockAddress = pairedStock;
  return payload;
}

async function launchOnBankr(router, apiKey, simulateOnly) {
  setWizardStep("launch", simulateOnly ? "Simulating launch" : "Launching on Bankr");
  output.textContent = simulateOnly
    ? "Calling Bankr simulateOnly… your API key stays in this browser."
    : "Calling Bankr deploy… confirm this is the launch you want. Your API key stays in this browser.";

  const response = await fetch(BANKR_API, {
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

async function readFeeShare(feeManager, poolId, beneficiary) {
  const data = encodeGetSharesCalldata(normalizePoolId(poolId), beneficiary);
  const raw = await window.ethereum.request({
    method: "eth_call",
    params: [{ to: feeManager, data }, "latest"],
  });
  if (!raw || raw === "0x") return 0n;
  return BigInt(raw);
}

function renderVerification({ shares, router, creatorAddress, simulated }) {
  const readout = document.querySelector("#fee-verify-readout");
  const verified = shares >= MIN_FEE_SHARE;
  const creatorMatches = creatorAddress?.toLowerCase() === router.toLowerCase();

  readout.classList.remove("hidden", "verify-pass", "verify-fail");
  readout.classList.add(verified ? "verify-pass" : "verify-fail");

  const sharePct = Number(shares) / 1e16 / 100;
  const lines = [
    verified
      ? "Verified — this router receives at least 95% of pool fees."
      : "Not verified yet — fees are not pointed at this router.",
    `Onchain fee share: ${sharePct.toFixed(2)}%`,
  ];

  if (creatorAddress) {
    lines.push(
      creatorMatches
        ? "Bankr creator beneficiary matches this router."
        : `Bankr creator beneficiary is ${shortAddress(creatorAddress)}, not this router.`,
    );
  }
  if (simulated) {
    lines.push("This was a simulation only. Run a live launch to deploy the token.");
  } else if (verified) {
    lines.push("Next: governance binds this pool and enrolls the router in the Hub.");
  } else {
    lines.push("Point Bankr fees to the router, then verify again.");
  }

  readout.innerHTML = lines.map((line) => `<p>${line}</p>`).join("");
  setWizardStep(verified ? "verified" : "verify", verified ? "Fees verified" : "Verify fees");
  output.textContent = verified
    ? "Launch complete and fee recipient verified onchain."
    : "Launch recorded, but onchain fee share is below 95%. Check Bankr fee recipient settings.";
}

async function verifyFeeRecipient({ poolId, router, feeDistribution, simulated }) {
  setWizardStep("verify", "Verifying fees");
  output.textContent = "Reading Doppler fee shares on Robinhood Chain…";

  const feeManager = value("fee-manager") || ROBINHOOD_FEE_MANAGER;
  const shares = await readFeeShare(feeManager, poolId, router);
  const creatorAddress = feeDistribution?.creator?.address;
  renderVerification({ shares, router, creatorAddress, simulated });
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
        feeDistribution: launch.feeDistribution,
        simulated: false,
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

  state.busy = true;
  createButton.disabled = true;
  setWizardStep("wallet", "Connect wallet");

  try {
    const account = state.connectedAccount ?? await connectWallet();
    if (!account) return;
    await ensureRobinhoodChain();

    const router = await createRouterOnchain(account);
    bankrVerifyFields?.classList.remove("hidden");

    const poolId = value("verify-pool-id");
    if (poolId) {
      await verifyFeeRecipient({ poolId, router, simulated: false });
    } else {
      setWizardStep("verify", "Point fees here");
      output.textContent =
        `Router ${router} is ready. Set it as Bankr's fee recipient, then paste the pool ID and click Verify.`;
    }
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

async function verifyExistingFees(event) {
  event.preventDefault();
  if (!state.lastRouter) {
    output.textContent = "Create a router first.";
    return;
  }
  const poolId = value("verify-pool-id");
  if (!poolId) {
    output.textContent = "Paste the Doppler pool ID from Bankr or the block explorer.";
    return;
  }

  try {
    await connectWallet();
    await ensureRobinhoodChain();
    await verifyFeeRecipient({
      poolId,
      router: state.lastRouter,
      feeDistribution: state.lastLaunch?.feeDistribution,
      simulated: false,
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

function populatePairedStocks() {
  const select = document.querySelector("#paired-stock");
  if (!select || select.options.length > 1) return;
  PAIRED_STOCKS.forEach((stock) => {
    const option = document.createElement("option");
    option.value = stock.value;
    option.textContent = stock.label;
    select.append(option);
  });
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
document.querySelector("#verify-fees-button")?.addEventListener("click", verifyExistingFees);

populatePairedStocks();
refreshPreview();
setWizardStep("ready", "Ready");
loadApiStatus();
loadPlatform().then(loadUniversalDirectory);
