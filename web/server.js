import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const directory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(directory, "public");
const FALLBACK_API_URL = "https://paymedividends-production.up.railway.app";
const staticFiles = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "application/javascript; charset=utf-8" }],
]);

export function createWebServer({ env = process.env } = {}) {
  const apiUrl = (env.PUBLIC_API_URL ?? FALLBACK_API_URL).replace(/\/$/, "");

  return http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "ok", service: "paymedividends-web" }));
      return;
    }

    const pathname = new URL(request.url, "http://localhost").pathname;
    const asset = staticFiles.get(pathname);
    if (!asset || request.method !== "GET") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    try {
      let body = await readFile(path.join(publicDirectory, asset.file), "utf8");
      if (asset.file === "index.html") {
        body = body.replace("__PUBLIC_API_URL__", JSON.stringify(apiUrl));
      }
      response.writeHead(200, {
        "content-type": asset.type,
        "cache-control": asset.file === "index.html" ? "no-store" : "public, max-age=3600",
        "x-content-type-options": "nosniff",
      });
      response.end(body);
    } catch {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("Unable to load the application.");
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ports = new Set([portFrom(process.env.PORT), portFrom(process.env.PUBLIC_PORT)]);
  for (const port of ports) {
    createWebServer().listen(port, "0.0.0.0", () => {
      console.info(`paymedividends web listening on ${port}`);
    });
  }
}

function portFrom(value) {
  const port = Number.parseInt(value ?? "3000", 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3000;
}
