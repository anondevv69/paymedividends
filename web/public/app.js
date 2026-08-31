const state = {
  connectedAccount: null,
  programType: "newBankr",
};

const form = document.querySelector("#program-form");
const programChoices = [...document.querySelectorAll('input[name="programType"]')];
const allocationChoices = [...document.querySelectorAll('input[name="allocation"]')];
const treatmentChoices = [...document.querySelectorAll('input[name="treatment"]')];
const fundingChoices = [...document.querySelectorAll('input[name="universalFunding"]')];
const routeChoices = [...document.querySelectorAll('input[name="route"]')];
const bankrOnly = [...document.querySelectorAll(".bankr-only")];
const universalOnly = document.querySelector(".universal-only");
const holderAllocation = document.querySelector(".holder-allocation");
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

function distributionRoute() {
  return isUniversal() ? "universal" : selectedValue("route");
}

function routeAllocations() {
  if (distributionRoute() === "direct") return { holders: 100, universal: 0 };
  if (distributionRoute() === "universal") return { holders: 0, universal: 100 };
  return { holders: 95, universal: 5 };
}

function displayPath() {
  if (isUniversal()) return "Join shared RWA index";
  return isNewLaunch() ? "Launch a Bankr token" : "Associate a Bankr token";
}

function payoutAsset() {
  if (isUniversal()) return value("contribution-asset");
  return selectedValue("treatment") === "swap" ? value("payout-target") : "Bankr paired asset";
}

function refreshPreview() {
  const token = value("token-symbol") || "TEST";
  const universal = isUniversal();
  const network = value("network") === "base" ? "Base" : "Robinhood Chain";
  const treatment = selectedValue("treatment");
  const asset = payoutAsset();
  const route = distributionRoute();
  const allocations = routeAllocations();
  const source = document.querySelector("#blueprint-source");

  document.querySelector("#blueprint-token").textContent = route === "universal" ? `$${token} member` : `$${token}`;
  document.querySelector("#blueprint-vault").textContent = universal
    ? "UniversalRewardsHub"
    : isNewLaunch() ? "Prelaunch project router" : "Bound project router";
  document.querySelector("#blueprint-asset").textContent = route === "universal"
    ? `${asset} → RWA basket`
    : route === "split" ? `${asset} claims + shared index` : `${asset} claims`;
  source.textContent = universal
    ? selectedValue("universalFunding") === "deposit" ? "approved direct deposit" : "Bankr feeRecipient"
    : "Bankr feeRecipient";
  document.querySelector("#blueprint-arrow").textContent = universal
    ? "approved funds → shared reward rounds"
    : treatment === "swap" ? `fixed swap route → ${allocations.holders}% local · ${allocations.universal}% Hub`
      : `${allocations.holders}% local · ${allocations.universal}% Hub`;
  document.querySelector("#detail-network").textContent = network;
  document.querySelector("#detail-program").textContent = displayPath();
  document.querySelector("#detail-entitlement").textContent = route === "universal"
    ? "all enrolled member-token holders"
    : route === "split" ? `${token} holders + shared-index members` : `${token} holders`;
  document.querySelector("#holder-allocation-bps").textContent = `${allocations.holders.toFixed(2)}%`;
  document.querySelector("#universal-allocation-bps").textContent = `${allocations.universal.toFixed(2)}%`;
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

function updateRoutingFields() {
  holderAllocation.classList.toggle("hidden", distributionRoute() === "universal");
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
routeChoices.forEach((input) => input.addEventListener("change", () => {
  selectLabel(input);
  updateRoutingFields();
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
  const route = distributionRoute();
  const allocations = routeAllocations();
  const recipient = route === "universal" ? "all enrolled member-token holders" : `${token} holders`;
  const currentAddress = address ? `It records ${shortAddress(address)} as the Bankr token. ` : "No Bankr token address is set yet. ";
  let sequence;

  if (isUniversal()) {
    sequence = selectedValue("universalFunding") === "deposit"
      ? `Use an approved ${asset} deposit into the future UniversalRewardsHub; its shared RWA reward rounds benefit ${recipient}.`
      : `Set a dedicated Project Router as the Bankr fee recipient. Its approved RWA fees forward to the future UniversalRewardsHub and benefit ${recipient}.`;
  } else if (isNewLaunch()) {
    sequence = `Create a prelaunch Project Router, launch the Bankr pair with that router as fee recipient, then bind the token address and Doppler pool ID that Bankr returns. ${treatment === "swap" ? `Creator-token fee conversion to ${asset} remains blocked pending an audited adapter.` : `Use quote-only fees for Bankr’s returned pair asset.`} The immutable route sends ${allocations.holders}% to ${recipient} and ${allocations.universal}% to the shared Hub.`;
  } else {
    sequence = `Create and bind a Project Router, then update the existing Bankr token’s fee recipient to that router if its fee beneficiary is still changeable. ${treatment === "swap" ? `Conversion to ${asset} remains blocked pending an audited adapter.` : `Bankr’s returned pair asset is routed without an extra protocol fee.`} The immutable route sends ${allocations.holders}% to ${recipient} and ${allocations.universal}% to the shared Hub.`;
  }

  document.querySelector("#blueprint-state").textContent = "Blueprint ready";
  document.querySelector("#detail-contract").textContent = "Awaiting test factory";
  output.textContent = `${displayPath()} blueprint ready for ${chain}. ${currentAddress}${sequence} No transaction has been generated in this preview.`;
});

function renderContributors(contributors) {
  const list = document.querySelector("#contributor-list");
  list.replaceChildren();
  if (!contributors.length) {
    const empty = document.createElement("div");
    empty.className = "empty-contributors";
    const title = document.createElement("span");
    title.textContent = "NO VERIFIED MEMBER TOKENS YET";
    const copy = document.createElement("p");
    copy.textContent = "After the Hub and Project Router Factory are deployed, this list will show every Bankr token with a verifiably enrolled router—never a self-reported or unverified token.";
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
    phase.textContent = data.phase === "not_deployed" ? "Awaiting deployment" : "Verified onchain";
    vault.textContent = data.universalRewardsHub ?? data.universalRevenueVault ?? "Not deployed";
    verification.textContent = data.verification;
    count.textContent = String(data.verifiedContributorCount ?? 0);
    renderContributors(data.contributors ?? []);
  } catch {
    phase.textContent = "Directory offline";
    verification.textContent = "The control plane could not be reached. No contributor data is shown until verification succeeds.";
  }
}

switchProgramType(state.programType);
toggleAdvancedTreatment();
updateRoutingFields();
loadApiStatus();
loadUniversalDirectory();
