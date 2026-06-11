const http = require("node:http");
const { spawn } = require("node:child_process");
const { URL } = require("node:url");
const { getRepoInfo } = require("../git.js");
const { fsp, path } = require("../utils.js");
const { createDashboardApi } = require("./dashboard-api.js");
const { createDashboardAuth, redactToken } = require("./dashboard-auth.js");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT_START = 47391;
const DEFAULT_PORT_END = 47420;
const DASHBOARD_REGISTRY_KEY = "__piOrchestratorDashboardServers";

const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
});

function dashboardRegistry() {
  const registry = globalThis[DASHBOARD_REGISTRY_KEY] || new Map();
  globalThis[DASHBOARD_REGISTRY_KEY] = registry;
  return registry;
}

function jsonResponse(res, statusCode, body, headers = {}) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function textResponse(res, statusCode, text, headers = {}) {
  const body = String(text || "");
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function errorPayload(error) {
  return {
    error: {
      message: error?.message || String(error || "Dashboard request failed."),
      code: error?.code,
    },
  };
}

function normalizePortRange(input) {
  if (Array.isArray(input) && input.length) return input.map(Number).filter(Number.isFinite);
  if (input && typeof input === "object") {
    const start = Number(input.start ?? input.from ?? DEFAULT_PORT_START);
    const end = Number(input.end ?? input.to ?? DEFAULT_PORT_END);
    if (start === 0 || end === 0) return [0];
    const ports = [];
    for (let port = start; port <= end; port += 1) ports.push(port);
    return ports;
  }
  const ports = [];
  for (let port = DEFAULT_PORT_START; port <= DEFAULT_PORT_END; port += 1) ports.push(port);
  return ports;
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address());
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function listenOnAvailablePort(createServer, host, portRange) {
  const ports = normalizePortRange(portRange);
  let lastError;
  for (const port of ports) {
    const server = createServer();
    try {
      const address = await listen(server, host, port);
      return { server, address };
    } catch (error) {
      lastError = error;
      server.close?.(() => {});
      if (port === 0 || (error.code !== "EADDRINUSE" && error.code !== "EACCES")) throw error;
    }
  }
  throw lastError || new Error(`No available dashboard port in range ${ports.join(", ")}.`);
}

function routeParts(url) {
  return url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

class DashboardServer {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.repoRoot = options.repoRoot;
    this.host = options.host || DEFAULT_HOST;
    if (this.host !== DEFAULT_HOST) throw new Error("Porchestrator dashboard only supports 127.0.0.1 binding in this version.");
    this.portRange = options.portRange;
    this.auth = createDashboardAuth({ token: options.token });
    this.api = options.api || createDashboardApi({ cwd: this.cwd, repoRoot: this.repoRoot, client: options.client, clientFactory: options.clientFactory });
    this.staticDir = options.staticDir || path.resolve(__dirname, "../..", "dashboard");
    this.defaultRunId = options.defaultRunId;
    this.server = undefined;
    this.port = undefined;
    this.startedAt = undefined;
    this.stopping = false;
  }

  async resolveRepoRoot() {
    if (this.repoRoot) return this.repoRoot;
    const repo = await getRepoInfo(this.cwd);
    this.repoRoot = repo.root;
    if (this.api && !this.api.repoRoot) this.api.repoRoot = repo.root;
    return this.repoRoot;
  }

  isRunning() {
    return Boolean(this.server?.listening && this.port);
  }

  address() {
    if (!this.isRunning()) return undefined;
    return { host: this.host, port: this.port };
  }

  url(params = {}) {
    if (!this.isRunning()) return undefined;
    const url = new URL(`http://${this.host}:${this.port}/`);
    const runId = params.runId || this.defaultRunId;
    if (runId) url.searchParams.set("runId", runId);
    url.searchParams.set("token", this.auth.token);
    return url.toString();
  }

  redactedUrl(params = {}) {
    const full = this.url(params);
    if (!full) return undefined;
    return full.replace(this.auth.token, redactToken(this.auth.token));
  }

  async start() {
    if (this.isRunning()) return this;
    await this.resolveRepoRoot();
    const { server, address } = await listenOnAvailablePort(
      () => http.createServer((req, res) => this.handleRequest(req, res)),
      this.host,
      this.portRange,
    );
    this.server = server;
    this.port = address.port;
    this.startedAt = new Date().toISOString();
    return this;
  }

  async stop() {
    this.stopping = true;
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  health() {
    return {
      ok: this.isRunning(),
      kind: "pi-multitask-dashboard-health",
      host: this.host,
      port: this.port,
      repoRoot: this.repoRoot,
      pid: process.pid,
      startedAt: this.startedAt,
      localOnly: true,
    };
  }

  async handleRequest(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${this.host}:${this.port || 0}`}`);
    try {
      if (!isLoopbackHost(this.host)) return textResponse(res, 403, "Dashboard is local-only.");
      if (req.method === "OPTIONS") return this.handleOptions(req, res);
      if (url.pathname === "/health" && req.method === "GET") return jsonResponse(res, 200, this.health());

      if (url.pathname.startsWith("/api/")) {
        if (!this.auth.authenticateRequest(req, url)) return jsonResponse(res, 401, { error: { message: "Unauthorized Porchestrator dashboard request." } });
        return this.handleApi(req, res, url);
      }

      return this.serveStatic(req, res, url);
    } catch (error) {
      return jsonResponse(res, 500, errorPayload(error));
    }
  }

  handleOptions(_req, res) {
    res.writeHead(204, {
      "access-control-allow-origin": "null",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
      "cache-control": "no-store",
    });
    res.end();
  }

  async readRequestBody(req) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 64 * 1024) throw new Error("Dashboard request body is too large.");
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    const text = Buffer.concat(chunks).toString("utf8");
    const contentType = String(req.headers["content-type"] || "");
    if (contentType.includes("text/plain")) return text;
    return JSON.parse(text);
  }

  async handleApi(req, res, url) {
    const parts = routeParts(url);
    const method = req.method || "GET";
    if (parts[0] !== "api") return jsonResponse(res, 404, { error: { message: "Unknown dashboard API route." } });

    if (method === "POST" && parts[1] === "runs" && parts[2]) {
      const runId = parts[2];
      if (parts.length === 4 && parts[3] === "message") return jsonResponse(res, 200, await this.api.messageRun(runId, await this.readRequestBody(req)));
      if (parts.length === 6 && parts[3] === "tasks" && parts[4] && parts[5] === "message") return jsonResponse(res, 200, await this.api.messageTask(runId, parts[4], await this.readRequestBody(req)));
    }

    if (method !== "GET") {
      return jsonResponse(res, 405, { error: { message: "Dashboard supports read-only APIs plus safe message/steer actions only." } });
    }

    if (parts[1] === "status") return jsonResponse(res, 200, await this.api.status({ runId: url.searchParams.get("runId") || undefined }));
    if (parts[1] === "runs" && parts.length === 2) return jsonResponse(res, 200, await this.api.runs());
    if (parts[1] === "doctor") return jsonResponse(res, 200, await this.api.doctor({ runId: url.searchParams.get("runId") || undefined }));
    if (parts[1] === "agents") return jsonResponse(res, 200, await this.api.agents({ includeProject: url.searchParams.get("includeProject") !== "false" }));
    if (parts[1] === "config") return jsonResponse(res, 200, await this.api.config());
    if (parts[1] === "events" && parts[2] === "stream") return jsonResponse(res, 501, { error: { message: "SSE live updates are reserved for Porchestrator dashboard Phase 2." } });

    if (parts[1] === "runs" && parts[2]) {
      const runId = parts[2];
      if (parts.length === 3) return jsonResponse(res, 200, await this.api.run(runId));
      if (parts[3] === "events") return jsonResponse(res, 200, await this.api.events(runId, { limit: url.searchParams.get("limit") }));
      if (parts[3] === "review") return jsonResponse(res, 200, await this.api.review(runId));
      if (parts[3] === "integration") return jsonResponse(res, 200, await this.api.integration(runId));
      if (parts[3] === "tasks" && parts[4]) {
        const taskId = parts[4];
        if (parts.length === 5) return jsonResponse(res, 200, await this.api.task(runId, taskId));
        if (parts[5] === "transcript") return jsonResponse(res, 200, await this.api.transcript(runId, taskId, { limit: url.searchParams.get("limit") }));
        if (parts[5] === "diff") return jsonResponse(res, 200, await this.api.diff(runId, taskId, { maxFiles: url.searchParams.get("maxFiles") }));
      }
    }

    return jsonResponse(res, 404, { error: { message: "Unknown dashboard API route." } });
  }

  async serveStatic(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") return textResponse(res, 405, "Method not allowed.");
    let fileName = "index.html";
    if (url.pathname === "/app.js") fileName = "app.js";
    else if (url.pathname === "/styles.css") fileName = "styles.css";
    else if (url.pathname === "/" || url.pathname === "/index.html") fileName = "index.html";
    else if (!url.pathname.startsWith("/api/")) fileName = "index.html";
    const file = path.join(this.staticDir, fileName);
    const body = await fsp.readFile(file);
    res.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
      "content-length": body.length,
    });
    if (req.method === "HEAD") return res.end();
    res.end(body);
  }
}

async function resolveRepoRootForOptions(options = {}) {
  if (options.repoRoot) return options.repoRoot;
  const repo = await getRepoInfo(options.cwd || process.cwd());
  return repo.root;
}

async function startDashboardServer(options = {}) {
  const repoRoot = await resolveRepoRootForOptions(options);
  const registry = dashboardRegistry();
  const existing = registry.get(repoRoot);
  if (existing?.isRunning()) {
    if (options.defaultRunId !== undefined) existing.defaultRunId = options.defaultRunId;
    return { server: existing, reused: true, url: existing.url({ runId: options.defaultRunId }) };
  }
  if (existing) registry.delete(repoRoot);
  const server = new DashboardServer({ ...options, repoRoot });
  await server.start();
  registry.set(repoRoot, server);
  return { server, reused: false, url: server.url({ runId: options.defaultRunId }) };
}

async function stopDashboardServer(options = {}) {
  const repoRoot = await resolveRepoRootForOptions(options);
  const registry = dashboardRegistry();
  const server = registry.get(repoRoot);
  if (!server) return { stopped: false, repoRoot };
  await server.stop();
  registry.delete(repoRoot);
  return { stopped: true, repoRoot };
}

async function getDashboardServerStatus(options = {}) {
  const repoRoot = await resolveRepoRootForOptions(options);
  const server = dashboardRegistry().get(repoRoot);
  if (!server?.isRunning()) return { running: false, repoRoot };
  return {
    running: true,
    repoRoot,
    health: server.health(),
    url: server.url({ runId: options.defaultRunId }),
    redactedUrl: server.redactedUrl({ runId: options.defaultRunId }),
  };
}

async function stopAllDashboardServers() {
  const registry = dashboardRegistry();
  const servers = Array.from(registry.values());
  registry.clear();
  await Promise.all(servers.map((server) => server.stop().catch(() => {})));
  return { stopped: servers.length };
}

function openDashboardUrl(url) {
  if (!url) return undefined;
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", `"${String(url).replace(/"/g, "\"\"")}"`] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref?.();
    return { command, args };
  } catch (error) {
    return { command, args, error: error.message };
  }
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT_END,
  DEFAULT_PORT_START,
  DashboardServer,
  dashboardRegistry,
  getDashboardServerStatus,
  listenOnAvailablePort,
  openDashboardUrl,
  startDashboardServer,
  stopAllDashboardServers,
  stopDashboardServer,
};
