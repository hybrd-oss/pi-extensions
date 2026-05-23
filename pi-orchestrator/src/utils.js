const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_CAPTURE_BYTES = 64 * 1024;

function slugify(value, fallback = "run") {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

function createRunId(runName) {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/T/, "-").replace(/\..+$/, "");
  const suffix = crypto.randomBytes(3).toString("hex");
  const name = slugify(runName, "run");
  return `${stamp}-${name}-${suffix}`;
}

function truncateMiddle(text, maxBytes = MAX_CAPTURE_BYTES) {
  const str = String(text ?? "");
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
  const headBytes = Math.floor(maxBytes * 0.6);
  const tailBytes = Math.floor(maxBytes * 0.35);
  const head = Buffer.from(str).subarray(0, headBytes).toString("utf8");
  const tail = Buffer.from(str).subarray(Math.max(0, Buffer.byteLength(str, "utf8") - tailBytes)).toString("utf8");
  return `${head}\n\n[... output truncated ...]\n\n${tail}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command, args = [], options = {}) {
  const {
    cwd,
    env,
    timeoutSeconds,
    signal,
    input,
    shell = false,
    maxCaptureBytes = MAX_CAPTURE_BYTES,
  } = options;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timeoutId;

    const proc = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      shell,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      resolve({
        ...result,
        stdout: truncateMiddle(stdout, maxCaptureBytes),
        stderr: truncateMiddle(stderr, maxCaptureBytes),
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    };

    if (timeoutSeconds && timeoutSeconds > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000).unref?.();
      }, timeoutSeconds * 1000);
    }

    if (signal) {
      const abort = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000).unref?.();
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      proc.on("close", () => signal.removeEventListener?.("abort", abort));
    }

    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout, "utf8") > maxCaptureBytes * 2) stdout = truncateMiddle(stdout, maxCaptureBytes);
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      if (Buffer.byteLength(stderr, "utf8") > maxCaptureBytes * 2) stderr = truncateMiddle(stderr, maxCaptureBytes);
    });
    proc.on("error", (error) => {
      stderr += error.message;
      finish({ exitCode: 1, error });
    });
    proc.on("close", (code, signalName) => finish({ exitCode: code ?? 0, signal: signalName }));

    if (input !== undefined && proc.stdin) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
  });
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function resolveMaybeRelative(base, value) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.resolve(base, value);
}

function relPath(from, to) {
  const relative = path.relative(from, to);
  return relative || ".";
}

module.exports = {
  MAX_CAPTURE_BYTES,
  createRunId,
  ensureDir,
  fs,
  fsp,
  os,
  path,
  pathExists,
  relPath,
  resolveMaybeRelative,
  runCommand,
  sleep,
  slugify,
  truncateMiddle,
};
