import { ProxyAgent, fetch as undiciFetch } from "undici";

const proxyAgentCache = new Map();

/**
 * Parse proxy strings:
 * - http://user:pass@host:port
 * - host:port:user:pass
 */
export function parseProxyUrl(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  if (/^https?:\/\//i.test(value)) {
    return new URL(value).toString();
  }

  const parts = value.split(":");
  if (parts.length < 4) {
    throw new Error("proxy_url_invalid");
  }

  const [host, port, username, ...passwordParts] = parts;
  const password = passwordParts.join(":");
  if (!host || !port || !username || !password) {
    throw new Error("proxy_url_invalid");
  }

  return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
}

export function pickProxyUrl(proxyValue) {
  if (!proxyValue) return null;
  const candidates = String(proxyValue)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (candidates.length === 0) return null;
  const selected = candidates[Math.floor(Math.random() * candidates.length)];
  return parseProxyUrl(selected);
}

function getProxyAgent(proxyUrl) {
  if (!proxyAgentCache.has(proxyUrl)) {
    proxyAgentCache.set(proxyUrl, new ProxyAgent(proxyUrl));
  }
  return proxyAgentCache.get(proxyUrl);
}

export function createProxyFetch(proxyUrl) {
  const normalized = parseProxyUrl(proxyUrl);
  if (!normalized) return fetch;
  const agent = getProxyAgent(normalized);
  return (url, init = {}) => undiciFetch(url, { ...init, dispatcher: agent });
}

export function createViemHttpOptions(proxyUrl) {
  const normalized = parseProxyUrl(proxyUrl);
  if (!normalized) return {};
  return {
    fetchOptions: {
      dispatcher: getProxyAgent(normalized),
    },
  };
}
