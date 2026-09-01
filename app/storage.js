import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Content-addressed manifest store.
 * Uses pmd://<keccak-or-sha> URIs that are IPFS-compatible in shape and can later pin to IPFS.
 */
export function createManifestStore({ directory = null, memory = new Map() } = {}) {
  return {
    async put(uri, body) {
      const key = normalizeKey(uri);
      memory.set(key, body);
      if (directory) {
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, key), body, "utf8");
      }
      return uri.startsWith("pmd://") ? uri : `pmd://${key}`;
    },

    async get(uri) {
      const key = normalizeKey(uri);
      if (memory.has(key)) return memory.get(key);
      if (!directory) return null;
      try {
        return await readFile(path.join(directory, key), "utf8");
      } catch {
        return null;
      }
    },

    async has(uri) {
      return (await this.get(uri)) !== null;
    },

    fingerprint(body) {
      return createHash("sha256").update(body).digest("hex");
    },
  };
}

function normalizeKey(uri) {
  return String(uri).replace(/^pmd:\/\//, "").replace(/^ipfs:\/\//, "").toLowerCase();
}
