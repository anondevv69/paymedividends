const state = {
  connectedAccount: null,
  programType: "newBankr",
};

const form = document.querySelector("#program-form");
const programChoices = [...document.querySelectorAll('input[name="programType"]')];
const allocationChoices = [...document.querySelectorAll('input[name="allocation"]')];
const treatmentChoices = [...document.querySelectorAll('input[name="treatment"]')];
const fundingChoices = [...document.querySelectorAll('input[name="universalFunding"]')];
const bankrOnly = [...document.querySelectorAll(".bankr-only")];
const universalOnly = document.querySelector(".universal-only");
const advancedTreatment = document.querySelector(".advanced-treatment");
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

function selectedValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}

function isUniversal() {
  return state.programType === "universal";
}

function isNewLaunch() {
  return state.programType === "newBankr";
}

function displayPath() {
  if (isUniversal()) return "Universal pool partner";
  return isNewLaunch() ? "New Bankr token" : "Existing Bankr token";
}

function payoutAsset() {
  if (isUniversal()) return value("contribution-asset");
  return selectedValue("treatment") === "swap" ? value("payout-target") : value("paired-asset");
}

function refreshPreview() {
  const token = value("token-symbol") || "TEST";
  const universal = isUniversal();
  const network = value("network") === "base" ? "Base" : "Robinhood Chain";
  const treatment = selectedValue("treatment");
  const asset = payoutAsset();
  const source = document.querySelector("#blueprint-source");

  document.querySelector("#blueprint-token").textContent = universal ? `$${token} contributor` : `$${token}`;
  document.querySelector("#blueprint-vault").textContent = universal
    ? "Universal revenue vault"
    : isNewLaunch() ? "Prelaunch payout vault" : "Bound project vault";
  document.querySelector("#blueprint-asset").textContent = universal ? `${asset} → RWA basket` : `${asset} claims`;
  source.textContent = universal
    ? selectedValue("universalFunding") === "deposit" ? "approved direct deposit" : "Bankr feeRecipient"
    : "Bankr feeRecipient";
  document.querySelector("#blueprint-arrow").textContent = universal
    ? "approved funds → RWA basket"
    : treatment === "swap" ? "fixed swap route → 5% protocol · 95% holders" : "5% protocol · 95% holders";
  document.querySelector("#detail-network").textContent = network;
  document.querySelector("#detail-program").textContent = displayPath();
  document.querySelector("#detail-entitlement").textContent = universal ? "$UNIVERSAL holders" : `${token} holders`;
}

function switchProgramType(next) {
  state.programType = next;
  bankrOnly.forEach((element) => element.classList.toggle("hidden", next === "universal"));
  universalOnly.classList.toggle("hidden", next !== "universal");
  refreshPreview();
}

function toggleAdvancedTreatment() {
  advancedTreatment.classList.toggle("hidden", selectedValue("treatment") !== "swap");
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
treatmentChoices.forEach((input) => input.addEventListener("change", () => {
  selectLabel(input);
  toggleAdvancedTreatment();
}));
fundingChoices.forEach((input) => input.addEventListener("change", () => {
  selectLabel(input);
  refreshPreview();
}));
form.querySelectorAll("input, select").forEach((input) => input.addEventListener("input", refreshPreview));
walletButton.addEventListener("click", connectWallet);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const token = value("token-symbol") || "TEST";
  const address = value("token-address");
  const chain = value("network") === "base" ? "Base (8453)" : "Robinhood Chain (4663)";
  const asset = payoutAsset();
  const treatment = selectedValue("treatment");
  const recipient = isUniversal() ? "$UNIVERSAL holders" : `${token} holders`;
  const currentAddress = address ? `It records ${shortAddress(address)} as the Bankr token. ` : "No Bankr token address is set yet. ";
  let sequence;

  if (isUniversal()) {
    sequence = selectedValue("universalFunding") === "deposit"
      ? `Use an approved ${asset} deposit into the future UniversalRevenueVault; its RWA basket benefits ${recipient}.`
      : `Set the future UniversalRevenueVault as the Bankr fee recipient; Bankr fee revenue benefits ${recipient}.`;
  } else if (isNewLaunch()) {
    sequence = `Create a prelaunch vault, launch the Bankr pair with that vault as fee recipient, then bind the token address and Doppler pool ID that Bankr returns. ${treatment === "swap" ? `Creator-token fee conversion to ${asset} remains blocked pending an audited adapter.` : `Use quote-only fees and reserve the paired ${asset} for ${recipient}.`}`;
  } else {
    sequence = `Create and bind a project vault, then update the existing Bankr token’s fee recipient to that vault if its fee beneficiary is still changeable. ${treatment === "swap" ? `Conversion to ${asset} remains blocked pending an audited adapter.` : `The paired ${asset} is reserved for ${recipient}.`}`;
  }

  document.querySelector("#blueprint-state").textContent = "Blueprint ready";
  document.querySelector("#detail-contract").textContent = "Awaiting test factory";
  output.textContent = `${displayPath()} blueprint ready for ${chain}. ${currentAddress}${sequence} No transaction has been generated in this preview.`;
});

switchProgramType(state.programType);
toggleAdvancedTreatment();
loadApiStatus();
