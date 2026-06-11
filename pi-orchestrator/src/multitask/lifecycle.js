const net = require("node:net");
const { ensureDir, fs, fsp, path, pathExists } = require("../utils.js");
const { daemonPidPath, daemonSocketPath, multitaskRoot } = require("./manifest.js");

const DEFAULT_SOCKET_PROBE_TIMEOUT_MS = 250;

function parsePid(value) {
  const pid = Number(String(value || "").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function readDaemonPid(repoRoot, options = {}) {
  const pidPath = options.pidPath || daemonPidPath(repoRoot);
  if (!(await pathExists(pidPath))) return undefined;
  return parsePid(await fsp.readFile(pidPath, "utf8"));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function probeSocket(socketPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SOCKET_PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    if (!socketPath) return resolve(false);
    const socket = net.createConnection(socketPath);
    let settled = false;
    let timer;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
    if (timeoutMs > 0) timer = setTimeout(() => finish(false), timeoutMs);
  });
}

async function getDaemonStatus(repoRoot, options = {}) {
  const pidPath = options.pidPath || daemonPidPath(repoRoot);
  const socketPath = options.socketPath || daemonSocketPath(repoRoot);
  const pidFileExists = await pathExists(pidPath);
  const rawPid = pidFileExists ? await fsp.readFile(pidPath, "utf8").catch(() => "") : "";
  const pid = parsePid(rawPid);
  const pidAlive = pid ? isProcessAlive(pid) : false;
  const socketExists = await pathExists(socketPath);
  const socketReachable = socketExists ? await probeSocket(socketPath, options) : false;
  const stalePid = pidFileExists && (!pid || !pidAlive);
  const staleSocket = socketExists && !socketReachable && (!pid || !pidAlive || options.allowCurrentProcess === true && pid === process.pid);
  const degraded = Boolean(pidAlive && !socketReachable);
  const status = socketReachable
    ? "running"
    : stalePid || staleSocket
      ? "stale"
      : degraded
        ? "degraded"
        : "stopped";

  return {
    repoRoot,
    pidPath,
    socketPath,
    pidPathExists: pidFileExists,
    pid,
    pidAlive,
    socketExists,
    socketReachable,
    stalePid,
    staleSocket,
    degraded,
    status,
  };
}

function formatDaemonStatus(status) {
  if (!status) return "Porchestrator daemon: unknown";
  const bits = [`Porchestrator daemon: ${status.status || "unknown"}`];
  if (status.pid) bits.push(`pid ${status.pid}${status.pidAlive ? " alive" : " stale"}`);
  else if (status.pidPathExists) bits.push("pid invalid");
  if (status.socketPath) bits.push(`socket ${status.socketReachable ? "reachable" : status.socketExists ? "stale" : "missing"}`);
  if (status.stalePid || status.staleSocket) bits.push("cleanup available");
  return bits.join(" · ");
}

async function cleanupDaemonFiles(repoRoot, options = {}) {
  const status = options.status || await getDaemonStatus(repoRoot, options);
  const removed = [];
  const skipped = [];
  const force = options.force === true;
  const mayRemovePid = force || status.stalePid || status.status === "stopped" || status.degraded && status.pid === process.pid;
  const mayRemoveSocket = force || status.staleSocket || status.status === "stopped" || status.degraded && status.pid === process.pid;

  if (!force && status.socketReachable) {
    skipped.push({ path: status.socketPath, reason: "daemon socket is reachable" });
  } else if (await pathExists(status.socketPath)) {
    if (mayRemoveSocket) {
      await fsp.rm(status.socketPath, { force: true }).catch(() => {});
      removed.push({ path: status.socketPath, type: "socket" });
    } else {
      skipped.push({ path: status.socketPath, reason: "daemon may still be running" });
    }
  }

  if (!force && status.pidAlive && status.pid !== process.pid) {
    skipped.push({ path: status.pidPath, reason: `pid ${status.pid} is alive` });
  } else if (await pathExists(status.pidPath)) {
    if (mayRemovePid) {
      await fsp.rm(status.pidPath, { force: true }).catch(() => {});
      removed.push({ path: status.pidPath, type: "pid" });
    } else {
      skipped.push({ path: status.pidPath, reason: "daemon pid may still be running" });
    }
  }

  return { status, removed, skipped };
}

async function cleanupStaleDaemonFiles(repoRoot, options = {}) {
  const status = options.status || await getDaemonStatus(repoRoot, options);
  if (!status.stalePid && !status.staleSocket) return { status, removed: [], skipped: [] };
  return cleanupDaemonFiles(repoRoot, { ...options, status });
}

async function prepareDaemonEndpoint(repoRoot, options = {}) {
  const socketPath = options.socketPath || daemonSocketPath(repoRoot);
  await ensureDir(path.dirname(socketPath));
  await ensureDir(multitaskRoot(repoRoot));
  const status = await getDaemonStatus(repoRoot, { ...options, socketPath, allowCurrentProcess: true });
  if (status.socketReachable) {
    throw new Error(`${formatDaemonStatus(status)}. Refusing to replace an active multitask daemon.`);
  }
  if (status.pidAlive && status.pid !== process.pid && options.allowLivePid !== true) {
    throw new Error(`${formatDaemonStatus(status)}. Refusing to replace live daemon pid ${status.pid}.`);
  }
  const cleanup = await cleanupDaemonFiles(repoRoot, { ...options, status, socketPath });
  return { socketPath, status, cleanup };
}

async function writeDaemonPid(repoRoot, pid = process.pid, options = {}) {
  const pidPath = options.pidPath || daemonPidPath(repoRoot);
  await ensureDir(path.dirname(pidPath));
  await fsp.writeFile(pidPath, `${pid}\n`, "utf8");
  return pidPath;
}

function cleanupDaemonFilesSync(repoRoot, options = {}) {
  const pidPath = options.pidPath || daemonPidPath(repoRoot);
  const socketPath = options.socketPath || daemonSocketPath(repoRoot);
  for (const file of [socketPath, pidPath]) {
    try {
      if (file && fs.existsSync(file)) fs.rmSync(file, { force: true });
    } catch {
      // Best-effort process-exit cleanup.
    }
  }
}

module.exports = {
  DEFAULT_SOCKET_PROBE_TIMEOUT_MS,
  cleanupDaemonFiles,
  cleanupDaemonFilesSync,
  cleanupStaleDaemonFiles,
  formatDaemonStatus,
  getDaemonStatus,
  isProcessAlive,
  parsePid,
  prepareDaemonEndpoint,
  probeSocket,
  readDaemonPid,
  writeDaemonPid,
};
