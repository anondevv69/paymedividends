import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { balancesFromEntries, balancesToEntries } from "./snapshot.js";

export function createMemoryCheckpointStore() {
  /** @type {Map<string, object>} */
  const checkpoints = new Map();

  return {
    async get(token) {
      return checkpoints.get(token.toLowerCase()) ?? null;
    },

    async put(token, checkpoint) {
      checkpoints.set(token.toLowerCase(), serializeCheckpoint(checkpoint));
      return checkpoint;
    },
  };
}

export function createFileCheckpointStore({ directory }) {
  if (!directory) throw new Error("checkpoint_directory_required");

  return {
    async get(token) {
      const filePath = checkpointPath(directory, token);
      try {
        const body = await readFile(filePath, "utf8");
        return deserializeCheckpoint(JSON.parse(body));
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },

    async put(token, checkpoint) {
      const filePath = checkpointPath(directory, token);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(serializeCheckpoint(checkpoint))}\n`, "utf8");
      return checkpoint;
    },
  };
}

export function createCheckpointStore({ directory = null, memory = null } = {}) {
  if (directory) return createFileCheckpointStore({ directory });
  return memory ?? createMemoryCheckpointStore();
}

export async function snapshotWithCheckpoint({
  rpcUrl,
  token,
  snapshotBlock,
  checkpointStore,
  snapshotBalancesAtBlock,
  fetchImpl = fetch,
}) {
  const normalized = token.toLowerCase();
  const checkpoint = await checkpointStore.get(normalized);

  let fromBlock = 0;
  let startingBalances = null;
  if (
    checkpoint
    && Number.isInteger(checkpoint.snapshotBlock)
    && checkpoint.snapshotBlock < snapshotBlock
  ) {
    fromBlock = checkpoint.snapshotBlock + 1;
    startingBalances = checkpoint.balances;
  } else if (checkpoint && checkpoint.snapshotBlock === snapshotBlock) {
    return {
      token: normalized,
      snapshotBlock,
      fromBlock: checkpoint.snapshotBlock,
      transferCount: 0,
      holderCount: checkpoint.balances.length,
      lastLog: checkpoint.lastLog ?? null,
      balances: checkpoint.balances,
      checkpointUsed: true,
      checkpointSaved: false,
    };
  }

  const result = await snapshotBalancesAtBlock({
    rpcUrl,
    token: normalized,
    snapshotBlock,
    fromBlock,
    startingBalances,
    fetchImpl,
  });

  await checkpointStore.put(normalized, {
    snapshotBlock: result.snapshotBlock,
    balances: result.balances,
    lastLog: result.lastLog,
    updatedAt: new Date().toISOString(),
  });

  return {
    ...result,
    checkpointUsed: Boolean(checkpoint),
    checkpointSaved: true,
  };
}

function checkpointPath(directory, token) {
  return path.join(directory, "checkpoints", `${token.toLowerCase()}.json`);
}

function serializeCheckpoint(checkpoint) {
  return {
    snapshotBlock: checkpoint.snapshotBlock,
    balances: balancesToEntries(balancesFromEntries(checkpoint.balances)),
    lastLog: checkpoint.lastLog ?? null,
    updatedAt: checkpoint.updatedAt ?? new Date().toISOString(),
  };
}

function deserializeCheckpoint(raw) {
  return {
    snapshotBlock: raw.snapshotBlock,
    balances: balancesToEntries(balancesFromEntries(raw.balances ?? [])),
    lastLog: raw.lastLog ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}
