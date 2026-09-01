const DEFAULTS = {
  chainId: 4663,
  chainHex: "0x1237",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
  factory: "0x4AD615B99e2B6E8e2C322c657Ac8f81F1806A3a7",
  hub: "0x6844D0814E904722777A48Ae2CF7C4b8F78a19e5",
};

const state = {
  connectedAccount: null,
  programType: "newBankr",
  platform: { ...DEFAULTS },
  lastRouter: null,
  busy: false,
};

const form = document.querySelector("#program-form");
const programChoices = [...document.querySelectorAll('input[name="programType"]')];
const walletButton = document.querySelector("#wallet-button");
const output = document.querySelector("#blueprint-output");
const createButton = document.querySelector("#create-router-button");

function selectLabel(input) {
  const group = [...document.querySelectorAll(`input[name="${input.name}"]`)];
  group.forEach((item) => item.closest(".choice")?.classList.toggle("selected", item.checked));
}

function shortAddress(address) {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function value(id) {
  return document.querySelector(`#${id}`).value.trim();
}

function displayPath() {
  if (state.programType === "universal") return "Join shared RWA index";
  return state.programType === "newBankr" ? "Launch a Bankr token" : "Point an existing Bankr token";
}

function pad32(hex) {
  return hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

function encodeCreateRouterCalldata(hub) {
  // createPrelaunchRouter(address,uint8,address,address) QuoteOnly + zero lockbox/adapter
  return `0xe1ad62bd${pad32(hub)}${pad32("0")}${pad32("0")}${pad32("0")}`;
}

function topicAddress(topic) {
  return `0x${topic.slice(-40)}`;
}

function refreshPreview() {
  const token = value("token-symbol") || "TEST";
  document.querySelector("#blueprint-token").textContent = `$${token} community`;
  document.querySelector("#detail-program").textContent = displayPath();
  if (!state.lastRouter) {
    document.querySelector("#blueprint-vault").textContent = "Create your Project Router";
  }
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
  document.querySelector("#blueprint-state").textContent = "Created";
  document.querySelector("#blueprint-vault").textContent = shortAddress(router);
  document.querySelector("#blueprint-source").textContent = "Paste into Bankr fee recipient";
  output.textContent =
    `Router ready. Copy ${router} and paste it into Bankr as the fee recipient. ` +
    `Tx ${shortAddress(txHash)}. Your connected wallet is the router admin.`;
}

async function createRouter(event) {
  event.preventDefault();
  if (state.busy) return;
  if (!state.platform.factory || !state.platform.hub) {
    output.textContent = "Factory/Hub addresses are not configured on the API yet.";
    return;
  }

  state.busy = true;
  createButton.disabled = true;
  document.querySelector("#blueprint-state").textContent = "Confirm in wallet";
  output.textContent = "Confirm the create-router transaction in your wallet…";

  try {
    const account = state.connectedAccount ?? await connectWallet();
    if (!account) return;
    await ensureRobinhoodChain();

    const data = encodeCreateRouterCalldata(state.platform.hub);
    const txHash = await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [{
        from: account,
        to: state.platform.factory,
        data,
      }],
    });

    document.querySelector("#blueprint-state").textContent = "Confirming";
    output.textContent = `Transaction submitted ${shortAddress(txHash)}. Waiting for confirmation…`;
    const receipt = await waitForReceipt(txHash);
    if (Number.parseInt(receipt.status, 16) !== 1) {
      throw new Error("Create-router transaction failed onchain.");
    }
    showRouter(routerFromReceipt(receipt), txHash);
  } catch (error) {
    document.querySelector("#blueprint-state").textContent = "Ready";
    output.textContent = error?.message
      ? `Could not create router: ${error.message}`
      : "Could not create router. The wallet may have rejected the request.";
  } finally {
    state.busy = false;
    createButton.disabled = false;
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
      "Create a router, point Bankr fees to it, then wait for Safe enrollment. Verified members show up here after indexing.";
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
    verification.textContent = "API offline. Defaults still allow router creation from this page.";
  }
}

programChoices.forEach((input) => input.addEventListener("change", () => {
  selectLabel(input);
  state.programType = input.value;
  refreshPreview();
}));
form.querySelectorAll("input").forEach((input) => input.addEventListener("input", refreshPreview));
walletButton.addEventListener("click", () => {
  connectWallet().catch(() => {
    output.textContent = "Wallet connection was not approved.";
  });
});
form.addEventListener("submit", createRouter);
document.querySelector("#copy-router").addEventListener("click", async () => {
  if (!state.lastRouter) return;
  await navigator.clipboard.writeText(state.lastRouter);
  output.textContent = `Copied ${state.lastRouter}. Paste it into Bankr as the fee recipient.`;
});

refreshPreview();
loadApiStatus();
loadPlatform().then(loadUniversalDirectory);
