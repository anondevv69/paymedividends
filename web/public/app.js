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
const BANKR_BUILD_TRANSFER = "https://api.bankr.bot/public/doppler/build-transfer-beneficiary";
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
  eligibleBeneficiaryTokens: [],
  pairedStocks: [],
  pairedStockByLabel: new Map(),
  feesVerified: false,
  enrollmentSubmitted: false,
  busy: false,
  wizardStep: "ready",
};

const form = document.querySelector("#program-form");
const programChoices = [...document.querySelectorAll('input[name="programType"]')];
const walletButton = document.querySelector("#wallet-button");
const output = document.querySelector("#blueprint-output");
const createButton = document.querySelector("#create-router-button");
const bankrLaunchFields = document.querySelector("#new-token-fields");
const bankrIntegratedFields = document.querySelector("#bankr-integrated-fields");
const existingTokenFields = document.querySelector("#existing-token-fields");
const bankrVerifyFields = document.querySelector("#bankr-verify-fields");
const simulateCheckbox = document.querySelector("#simulate-launch");
const retargetFeesButton = document.querySelector("#retarget-fees-button");
const requestEnrollmentButton = document.querySelector("#request-enrollment-button");

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
    ? "Launching a new token"
    : "Existing token → fee sink";
}

function tokenAddressForFlow() {
  if (state.programType === "existingBankr") return value("existing-token-address");
  return state.lastLaunch?.tokenAddress ?? value("existing-token-address");
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

function refreshVerificationActions({ verified, recipientMatches } = {}) {
  const needsRetarget = state.programType === "existingBankr"
    && state.lastRouter
    && state.bankrLookup
    && !verified
    && recipientMatches === false;
  retargetFeesButton?.classList.toggle("hidden", !needsRetarget);
  requestEnrollmentButton?.classList.toggle("hidden", !verified || state.enrollmentSubmitted);
}

function refreshPreview() {
  const token = value("token-symbol") || value("token-name") || tokenAddressForFlow().slice(0, 6) || "TOKEN";
  document.querySelector("#blueprint-token").textContent = `$${token.toUpperCase()} community`;
  document.querySelector("#detail-program").textContent = displayPath();
  if (!state.lastRouter) {
    document.querySelector("#blueprint-vault").textContent =
      state.programType === "newBankr" ? "Fee router" : "Router for existing token";
  }

  const isNew = state.programType === "newBankr";
  bankrLaunchFields?.classList.toggle("hidden", !isNew);
  bankrIntegratedFields?.classList.remove("hidden");
  existingTokenFields?.classList.toggle("hidden", isNew);
  bankrVerifyFields?.classList.toggle("hidden", isNew && !state.lastLaunch && !state.lastRouter);

  if (isNew) {
    createButton.textContent = "Create router + launch on Bankr →";
  } else {
    createButton.textContent = "Join the fee sink →";
  }

  refreshVerificationActions({ verified: state.feesVerified });
}

function isFeeRecipientWallet(feeRecipientAddress, account) {
  return Boolean(
    feeRecipientAddress && account
    && feeRecipientAddress.toLowerCase() === account.toLowerCase(),
  );
}

function assertFeeRecipientAuthority(feeRecipientAddress, account) {
  if (isFeeRecipientWallet(feeRecipientAddress, account)) return;
  throw new Error(
    feeRecipientAddress
      ? `Connected wallet is not the fee beneficiary (${shortAddress(feeRecipientAddress)}). Connect that wallet or use Bankr bot to join the sink.`
      : "Could not confirm the Bankr fee beneficiary for this token.",
  );
}

function renderEligibleBeneficiaryTokens() {
  const status = document.querySelector("#beneficiary-tokens-status");
  const readout = document.querySelector("#eligible-beneficiary-readout");
  if (!status || !readout) return;

  if (!state.connectedAccount) {
    status.textContent = "Connect wallet to list tokens where you are the fee beneficiary.";
    readout.classList.add("hidden");
    return;
  }

  if (!state.eligibleBeneficiaryTokens.length) {
    status.textContent = "No Robinhood stock-paired tokens found for this wallet as fee beneficiary.";
    readout.classList.add("hidden");
    return;
  }

  status.textContent = `${state.eligibleBeneficiaryTokens.length} eligible token(s) on Robinhood Chain — tap to select:`;
  readout.classList.remove("hidden", "verify-pass", "verify-fail");
  readout.innerHTML = state.eligibleBeneficiaryTokens.map((token) =>
    `<p><button type="button" class="link-button" data-beneficiary-token="${token.tokenAddress}">`
    + `$${token.symbol} / ${token.pairedStockSymbol}`
    + `</button> · ${shortAddress(token.tokenAddress)}</p>`,
  ).join("");
}

async function loadBeneficiaryTokens(account) {
  if (!account || state.programType !== "existingBankr") return;
  const status = document.querySelector("#beneficiary-tokens-status");
  try {
    if (status) status.textContent = "Loading your Bankr fee-beneficiary tokens…";
    const response = await fetch(
      `${window.PAYMENTS_API_URL}/v1/bankr/beneficiary-fees/${account}`,
      { signal: AbortSignal.timeout(20000) },
    );
    if (!response.ok) throw new Error("Beneficiary list unavailable");
    const data = await response.json();
    state.eligibleBeneficiaryTokens = data.items ?? [];
    renderEligibleBeneficiaryTokens();
  } catch {
    state.eligibleBeneficiaryTokens = [];
    if (status) {
      status.textContent = "Could not load beneficiary tokens. Paste a token address manually.";
    }
    renderEligibleBeneficiaryTokens();
  }
}

function applyDeepLinkToken() {
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const token = params.get("token");
  if (!isAddress(token)) return;
  state.programType = "existingBankr";
  programChoices.forEach((input) => {
    input.checked = input.value === "existingBankr";
    selectLabel(input);
  });
  const field = document.querySelector("#existing-token-address");
  if (field) field.value = token;
  refreshPreview();
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
  await loadBeneficiaryTokens(account);
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
  document.querySelector("#blueprint-source").textContent = "Holder pro-rata sink";
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
      ? "Verified — fees route to the holder sink. Holders can claim pro-rata once enrolled."
      : "Not verified yet — fees are not pointed at the holder router.",
    `Onchain fee share: ${sharePct.toFixed(2)}%`,
  ];

  if (tokenSymbol) lines.unshift(`${tokenSymbol} pool checked.`);

  if (feeRecipientAddress) {
    lines.push(
      recipientMatches
        ? "Bankr fee recipient is the holder router."
        : `Fees still go to ${shortAddress(feeRecipientAddress)} — retarget to your holder router.`,
    );
  }

  if (simulated) {
    lines.push("This was a simulation only. Run a live launch to deploy the token.");
  } else if (verified) {
    lines.push("Next: request Hub enrollment — governance Safe reviews and enrolls the router.");
  } else if (state.programType === "existingBankr") {
    lines.push("Click Retarget fees to router — your wallet signs updateBeneficiary via Bankr.");
  } else {
    lines.push("Check Bankr fee recipient settings, then verify again.");
  }

  setReadout("fee-verify-readout", lines, verified ? "verify-pass" : "verify-fail");
  setWizardStep(verified ? "verified" : "verify", verified ? "Fees verified" : "Verify fees");
  state.feesVerified = verified;
  refreshVerificationActions({ verified, recipientMatches });
  output.textContent = verified
    ? "Holder router verified — request Hub enrollment to join the shared RWA pool."
    : "Token found, but fees are not routed to the holder sink yet.";
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

  await runIntegratedBankrLaunch();
}

async function retargetFeesToRouter(event) {
  event.preventDefault();
  if (state.busy) return;
  if (!state.lastRouter || !state.bankrLookup?.tokenAddress) {
    output.textContent = "Create a router and look up your token first.";
    return;
  }

  state.busy = true;
  retargetFeesButton.disabled = true;
  setWizardStep("verify", "Retargeting fees");

  try {
    const account = state.connectedAccount ?? await connectWallet();
    if (!account) return;
    await ensureRobinhoodChain();
    assertFeeRecipientAuthority(state.bankrLookup.feeRecipientAddress, account);

    output.textContent = "Building updateBeneficiary transaction via Bankr…";
    const response = await fetch(BANKR_BUILD_TRANSFER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tokenAddress: state.bankrLookup.tokenAddress,
        currentBeneficiary: account,
        newBeneficiary: state.lastRouter,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(bankrErrorMessage(payload, response.status));
    }

    output.textContent = "Confirm the fee retarget in your wallet…";
    const txHash = await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [{
        from: account,
        to: payload.to,
        data: payload.data,
      }],
    });

    output.textContent = `Retarget tx ${shortAddress(txHash)}. Waiting for confirmation…`;
    const receipt = await waitForReceipt(txHash);
    if (Number.parseInt(receipt.status, 16) !== 1) {
      throw new Error("Fee retarget transaction failed onchain.");
    }

    const lookup = await lookupBankrToken(state.bankrLookup.tokenAddress);
    await verifyFeeRecipient({
      poolId: lookup.poolId,
      router: state.lastRouter,
      feeRecipientAddress: lookup.feeRecipientAddress,
      simulated: false,
      tokenSymbol: lookup.tokenSymbol,
    });
  } catch (error) {
    setWizardStep("error", "Needs attention");
    output.textContent = error?.message
      ? `Could not retarget fees: ${error.message}`
      : "Could not retarget fees. The wallet may have rejected the request.";
  } finally {
    state.busy = false;
    retargetFeesButton.disabled = false;
    refreshPreview();
  }
}

async function submitEnrollmentRequest(event) {
  event.preventDefault();
  if (state.busy || !state.feesVerified || !state.lastRouter) {
    output.textContent = "Verify fees onchain before requesting Hub enrollment.";
    return;
  }

  const lookup = state.bankrLookup ?? state.lastLaunch;
  const tokenAddress = lookup?.tokenAddress ?? tokenAddressForFlow();
  const poolId = lookup?.poolId;
  if (!isAddress(tokenAddress) || !poolId) {
    output.textContent = "Token and pool must be resolved before enrollment.";
    return;
  }

  state.busy = true;
  requestEnrollmentButton.disabled = true;
  const statusEl = document.querySelector("#enrollment-status");

  try {
    const account = state.connectedAccount ?? await connectWallet();
    if (!account) return;

    const body = {
      tokenAddress,
      router: state.lastRouter,
      poolId,
      feeBeneficiary: account,
      tokenSymbol: lookup?.tokenSymbol ?? null,
      pairedStockSymbol: lookup?.pairedStockSymbol ?? null,
      requestedBy: account,
    };

    const response = await fetch(`${window.PAYMENTS_API_URL}/v1/enrollment-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message ?? payload.error ?? `Enrollment request failed (${response.status})`);
    }

    state.enrollmentSubmitted = true;
    if (statusEl) {
      statusEl.classList.remove("hidden");
      statusEl.textContent =
        "Enrollment queued for governance Safe review (7-day onchain delay after enrollMemberRouter). "
        + "Holder claims go live after enrollment + indexer rounds.";
    }
    output.textContent =
      `Enrollment request ${payload.id ?? "submitted"}. Governance will verify pool binding and enroll the router.`;
    refreshVerificationActions({ verified: true });
  } catch (error) {
    output.textContent = error?.message
      ? `Enrollment request failed: ${error.message}`
      : "Enrollment request failed.";
  } finally {
    state.busy = false;
    requestEnrollmentButton.disabled = false;
  }
}

async function runIntegratedBankrLaunch() {
  const apiKey = value("bankr-api-key");
  if (!apiKey.startsWith("bk_")) {
    output.textContent = "Enter your Bankr user API key (starts with bk_usr_). Get one from bankr.bot account settings.";
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
      applyBankrLookup({
        tokenAddress: launch.tokenAddress,
        tokenName: value("token-name"),
        tokenSymbol: value("token-symbol"),
        poolId: launch.poolId,
        feeRecipientAddress: router,
      });
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
    assertFeeRecipientAuthority(lookup.feeRecipientAddress, account);
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
  const tokenAddress = tokenAddressForFlow();
  if (!isAddress(tokenAddress)) {
    output.textContent = "Paste a valid token address (0x…).";
    return;
  }

  try {
    output.textContent = "Looking up token on Bankr…";
    const lookup = await lookupBankrToken(tokenAddress);
    bankrVerifyFields?.classList.remove("hidden");
    output.textContent =
      `Found ${lookup.tokenSymbol}. Current fee recipient: ${shortAddress(lookup.feeRecipientAddress)}.`;

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
    const tokenAddress = tokenAddressForFlow();
    if (tokenAddress && isAddress(tokenAddress)) {
      lookup = await lookupBankrToken(tokenAddress);
    }
    if (!lookup?.poolId) {
      output.textContent = "Paste a Bankr token address first.";
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
  if (state.programType === "existingBankr" && state.connectedAccount) {
    loadBeneficiaryTokens(state.connectedAccount);
  }
}));
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-beneficiary-token]");
  if (!button) return;
  const field = document.querySelector("#existing-token-address");
  if (field) field.value = button.dataset.beneficiaryToken;
  refreshPreview();
  lookupExistingToken(event);
});
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
retargetFeesButton?.addEventListener("click", retargetFeesToRouter);
requestEnrollmentButton?.addEventListener("click", submitEnrollmentRequest);

refreshPreview();
applyDeepLinkToken();
setWizardStep("ready", "Ready");
loadApiStatus();
loadPlatform().then(loadUniversalDirectory);
loadPairedStocks();
