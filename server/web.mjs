import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDirectory = process.cwd();
const clientDirectory = path.resolve(rootDirectory, "dist", "client");
const vinextCli = path.resolve(
  rootDirectory,
  "node_modules",
  "vinext",
  "dist",
  "cli.js",
);
const publicPort = Number.parseInt(process.env.PORT || "3000", 10);
const internalPort = Number.parseInt(
  process.env.RELAY_INTERNAL_WEB_PORT || String(publicPort + 1),
  10,
);
const publicHost = process.env.HOST || "0.0.0.0";
const internalHost = "127.0.0.1";
const controlHost = process.env.RELAY_CONTROL_HOST || "127.0.0.1";
const controlPort = Number.parseInt(process.env.PIPELINE_PORT || "4317", 10);
const controlProxyPrefix = "/relay-control";
let server;
let shuttingDown = false;

const contentTypes = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function resolveStaticFile(rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, "http://localhost").pathname);
  } catch {
    return null;
  }
  if (pathname === "/" || pathname.startsWith("/.vite/")) return null;
  const candidate = path.resolve(clientDirectory, `.${pathname}`);
  if (
    candidate !== clientDirectory &&
    !candidate.startsWith(`${clientDirectory}${path.sep}`)
  )
    return null;
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function serveStatic(request, response, filePath) {
  const stat = fs.statSync(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const isHashedAsset = filePath.startsWith(
    path.join(clientDirectory, "assets") + path.sep,
  );
  response.writeHead(200, {
    "Cache-Control": isHashedAsset
      ? "public, max-age=31536000, immutable"
      : "public, max-age=3600",
    "Content-Length": String(stat.size),
    "Content-Type": contentTypes[extension] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") response.end();
  else fs.createReadStream(filePath).pipe(response);
}

function proxyRequest(
  request,
  response,
  {
    upstreamHost = internalHost,
    upstreamPort = internalPort,
    upstreamPath = request.url,
    proxyHeader = "x-relay-web-proxy",
    preserveHost = false,
  } = {},
) {
  const upstream = http.request(
    {
      host: upstreamHost,
      port: upstreamPort,
      path: upstreamPath,
      method: request.method,
      headers: {
        ...request.headers,
        host: preserveHost
          ? request.headers.host
          : `${upstreamHost}:${upstreamPort}`,
      },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, {
        ...upstreamResponse.headers,
        [proxyHeader]: "1",
      });
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    response.writeHead(503, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end("Relay web renderer is starting. Please refresh shortly.");
  });
  request.pipe(upstream);
}

function waitForRenderer(timeoutMs = 15_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get(
        { host: internalHost, port: internalPort, path: "/" },
        (response) => {
          response.resume();
          resolve();
        },
      );
      request.once("error", () => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error("Timed out waiting for the vinext renderer"));
          return;
        }
        setTimeout(probe, 100);
      });
    };
    probe();
  });
}

if (!fs.existsSync(clientDirectory) || !fs.existsSync(vinextCli)) {
  console.error("Relay web build is missing. Run `npm run build` first.");
  process.exit(1);
}

const renderer = spawn(
  process.execPath,
  [
    vinextCli,
    "start",
    "--port",
    String(internalPort),
    "--hostname",
    internalHost,
  ],
  { cwd: rootDirectory, env: process.env, stdio: "inherit" },
);
renderer.once("exit", (code, signal) => {
  if (!shuttingDown) {
    console.error(
      `Relay web renderer stopped unexpectedly (${signal || code || "unknown"}).`,
    );
    process.exitCode = code || 1;
    if (server) server.close(() => process.exit(process.exitCode));
    else process.exit(process.exitCode);
  }
});

await waitForRenderer();

server = http.createServer((request, response) => {
  const rawUrl = request.url || "/";
  const pathname = new URL(rawUrl, "http://localhost").pathname;
  if (
    pathname === `${controlProxyPrefix}/api` ||
    pathname.startsWith(`${controlProxyPrefix}/api/`)
  ) {
    proxyRequest(request, response, {
      upstreamHost: controlHost,
      upstreamPort: controlPort,
      upstreamPath: rawUrl.slice(controlProxyPrefix.length),
      proxyHeader: "x-relay-control-proxy",
      preserveHost: true,
    });
    return;
  }
  if (!["GET", "HEAD"].includes(request.method || "GET")) {
    proxyRequest(request, response);
    return;
  }
  const staticFile = resolveStaticFile(rawUrl);
  if (staticFile) serveStatic(request, response, staticFile);
  else proxyRequest(request, response);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(publicPort, publicHost, () => {
    server.off("error", reject);
    console.log(
      `Relay web console running at http://${publicHost}:${publicPort} (renderer ${internalHost}:${internalPort})`,
    );
    resolve();
  });
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping Relay web console`);
  renderer.kill("SIGTERM");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
