const state = {
  connectedAccount: null,
  programType: "dedicated",
};

const form = document.querySelector("#program-form");
const programChoices = [...document.querySelectorAll('input[name="programType"]')];
const allocationChoices = [...document.querySelectorAll('input[name="allocation"]')];
const dedicatedOnly = document.querySelector(".dedicated-only");
const universalOnly = document.querySelector(".universal-only");
const walletButton = document.querySelector("#wallet-button");
const output = document.querySelector("#blueprint-output");

function selectLabel(input) {
  const group = [...document.querySelectorAll(`input[name="${input.name}"]`)];
  group.forEach((item) => item.closest(".choice")?.classList.toggle("selected", item.checked));
}

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function value(id) {
  return document.querySelector(`#${id}`).value.trim();
}

function refreshPreview() {
  const token = value("token-symbol") || "TEST";
  const isUniversal = state.programType === "universal";
  const network = value("network") === "base" ? "Base" : "Robinhood Chain";
  const payout = isUniversal ? value("contribution-asset") : value("payout-asset");
  document.querySelector("#blueprint-token").textContent = isUniversal ? `$${token} contributor` : `$${token}`;
  document.querySelector("#blueprint-vault").textContent = isUniversal ? "Universal revenue vault" : "Project payout vault";
  document.querySelector("#blueprint-asset").textContent = isUniversal ? `${payout} → RWA basket` : `${payout} claims`;
  document.querySelector("#blueprint-arrow").textContent = isUniversal ? "approved funds → RWA basket" : "5% protocol · 95% holders";
  document.querySelector("#detail-network").textContent = network;
  document.querySelector("#detail-program").textContent = isUniversal ? "Universal contributor" : "Dedicated payout";
  document.querySelector("#detail-entitlement").textContent = isUniversal ? "$UNIVERSAL holders" : `${token} holders`;
}

function switchProgramType(next) {
  state.programType = next;
  dedicatedOnly.classList.toggle("hidden", next !== "dedicated");
  universalOnly.classList.toggle("hidden", next !== "universal");
  refreshPreview();
}

async function connectWallet() {
  if (!window.ethereum) {
    walletButton.textContent = "Wallet not found";
    output.textContent = "Install or open a browser wallet to connect. The test blueprint still works without one.";
    return;
  }
  try {
    const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
    state.connectedAccount = account;
    walletButton.innerHTML = `${shortAddress(account)} <span>●</span>`;
    output.textContent = `Wallet ${shortAddress(account)} is connected. No transaction, token approval, or signature has been requested.`;
  } catch {
    output.textContent = "Wallet connection was not approved. You can still use the test blueprint without connecting.";
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

programChoices.forEach((input) => input.addEventListener("change", () => {
  selectLabel(input);
  switchProgramType(input.value);
}));
allocationChoices.forEach((input) => input.addEventListener("change", () => selectLabel(input)));
form.querySelectorAll("input, select").forEach((input) => input.addEventListener("input", refreshPreview));
walletButton.addEventListener("click", connectWallet);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const token = value("token-symbol") || "TEST";
  const address = value("token-address");
  const chain = value("network") === "base" ? "Base (8453)" : "Robinhood Chain (4663)";
  const dedicated = state.programType === "dedicated";
  const recipient = dedicated ? `${token} holders` : "$UNIVERSAL holders";
  const asset = dedicated ? value("payout-asset") : value("contribution-asset");
  document.querySelector("#blueprint-state").textContent = "Blueprint ready";
  document.querySelector("#detail-contract").textContent = "Awaiting test factory";
  output.textContent = `${dedicated ? "Dedicated" : "Universal contribution"} blueprint ready for ${chain}. ${address ? `It records ${shortAddress(address)} as the holder token. ` : "No token address is set yet. "}On test deployment, the wallet will create the vault; ${asset} revenue will be allocated to ${recipient}. No transaction has been generated in this preview.`;
});

refreshPreview();
loadApiStatus();
