/**
 * In-memory ERC-20 transfer indexer used to reconstruct holder sets at a snapshot block.
 * Production can swap the store for Postgres while keeping the same apply/getBalances API.
 */
export function createTransferIndexer({ store = createMemoryStore() } = {}) {
  return {
    store,

    async applyTransfer({ token, blockNumber, logIndex, from, to, value, txHash = null }) {
      const amount = BigInt(value);
      if (amount === 0n) return;
      const tokenKey = token.toLowerCase();
      await store.ensureToken(tokenKey);

      if (!isZeroAddress(from)) {
        await store.addBalance(tokenKey, from.toLowerCase(), -amount, blockNumber, logIndex);
      }
      if (!isZeroAddress(to)) {
        await store.addBalance(tokenKey, to.toLowerCase(), amount, blockNumber, logIndex);
      }
      await store.markCursor(tokenKey, blockNumber, logIndex, txHash);
    },

    async getBalances(token, atBlock) {
      return store.balancesAt(token.toLowerCase(), atBlock);
    },

    async getCursor(token) {
      return store.getCursor(token.toLowerCase());
    },
  };
}

export function createMemoryStore() {
  /** @type {Map<string, { balances: Map<string, bigint>, history: Array, cursor: object|null }>} */
  const tokens = new Map();

  function tokenState(token) {
    if (!tokens.has(token)) {
      tokens.set(token, { balances: new Map(), history: [], cursor: null });
    }
    return tokens.get(token);
  }

  return {
    async ensureToken(token) {
      tokenState(token);
    },

    async addBalance(token, account, delta, blockNumber, logIndex) {
      const state = tokenState(token);
      const next = (state.balances.get(account) ?? 0n) + delta;
      if (next < 0n) throw new Error(`negative_balance:${token}:${account}`);
      if (next === 0n) state.balances.delete(account);
      else state.balances.set(account, next);
      state.history.push({ account, delta, blockNumber, logIndex, balanceAfter: next });
    },

    async markCursor(token, blockNumber, logIndex, txHash) {
      tokenState(token).cursor = { blockNumber, logIndex, txHash };
    },

    async getCursor(token) {
      return tokenState(token).cursor;
    },

    async balancesAt(token, atBlock) {
      const state = tokenState(token);
      if (atBlock === undefined || atBlock === null) {
        return [...state.balances.entries()]
          .filter(([, balance]) => balance > 0n)
          .map(([account, balance]) => ({ account, balance: balance.toString() }));
      }

      const reconstructed = new Map();
      for (const entry of state.history) {
        if (entry.blockNumber > atBlock) break;
        const next = (reconstructed.get(entry.account) ?? 0n) + entry.delta;
        if (next === 0n) reconstructed.delete(entry.account);
        else reconstructed.set(entry.account, next);
      }
      return [...reconstructed.entries()]
        .filter(([, balance]) => balance > 0n)
        .map(([account, balance]) => ({ account, balance: balance.toString() }));
    },
  };
}

function isZeroAddress(address) {
  return /^0x0{40}$/i.test(address);
}
