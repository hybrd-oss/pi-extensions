const crypto = require("node:crypto");
const { daemonSocketPath } = require("./manifest.js");

const PROTOCOL_VERSION = 1;

const METHODS = Object.freeze({
  START: "multitask.start",
  SPAWN: "multitask.spawn",
  MESSAGE: "multitask.message",
  STATUS: "multitask.status",
  LOGS: "multitask.logs",
  DIFF: "multitask.diff",
  REVIEW: "multitask.review",
  MERGE: "multitask.merge",
  APPLY: "multitask.apply",
  CANCEL: "multitask.cancel",
  CLEANUP: "multitask.cleanup",
  RESUME: "multitask.resume",
  AGENTS: "multitask.agents",
  DOCTOR: "multitask.doctor",
  EXPORT: "multitask.export",
  PRUNE: "multitask.prune",
  PING: "daemon.ping",
  SHUTDOWN: "daemon.shutdown",
});

const MESSAGE_KINDS = Object.freeze({
  REQUEST: "request",
  RESPONSE: "response",
  EVENT: "event",
});

function createId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : crypto.randomBytes(12).toString("hex");
}

function createRequest(method, params = {}, options = {}) {
  if (!method || typeof method !== "string") throw new Error("Protocol method is required.");
  return {
    protocol: "pi-multitask",
    version: PROTOCOL_VERSION,
    kind: MESSAGE_KINDS.REQUEST,
    id: options.id || createId(),
    method,
    params,
    sentAt: new Date().toISOString(),
  };
}

function createResponse(request, result, error) {
  return {
    protocol: "pi-multitask",
    version: PROTOCOL_VERSION,
    kind: MESSAGE_KINDS.RESPONSE,
    id: request.id,
    method: request.method,
    ok: !error,
    result: error ? undefined : result,
    error: error ? serializeError(error) : undefined,
    sentAt: new Date().toISOString(),
  };
}

function createEvent(method, payload = {}) {
  return {
    protocol: "pi-multitask",
    version: PROTOCOL_VERSION,
    kind: MESSAGE_KINDS.EVENT,
    id: createId(),
    method,
    payload,
    sentAt: new Date().toISOString(),
  };
}

function serializeError(error) {
  if (!error) return undefined;
  return {
    name: error.name || "Error",
    message: error.message || String(error),
    code: error.code,
    stack: error.stack,
  };
}

function encodeMessage(message) {
  return JSON.stringify(message) + "\n";
}

function decodeLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return undefined;
  const message = JSON.parse(trimmed);
  validateMessage(message);
  return message;
}

function validateMessage(message) {
  if (!message || typeof message !== "object") throw new Error("Protocol message must be an object.");
  if (message.protocol !== "pi-multitask") throw new Error("Unsupported protocol message.");
  if (message.version !== PROTOCOL_VERSION) throw new Error(`Unsupported multitask protocol version ${message.version}.`);
  if (!Object.values(MESSAGE_KINDS).includes(message.kind)) throw new Error(`Unsupported protocol message kind ${message.kind}.`);
  if (!message.id || typeof message.id !== "string") throw new Error("Protocol message id is required.");
  return message;
}

function createLineDecoder(onMessage, onError = () => {}) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = decodeLine(line);
        if (message) onMessage(message);
      } catch (error) {
        onError(error, line);
      }
    }
  };
}

function flushLineDecoder(decoder, onMessage, onError = () => {}) {
  // Reserved for a future decoder object. Kept as a named protocol helper so callers do not depend on internals.
  return { decoder, onMessage, onError };
}

function defaultSocketPath(repoRoot) {
  return daemonSocketPath(repoRoot);
}

module.exports = {
  MESSAGE_KINDS,
  METHODS,
  PROTOCOL_VERSION,
  createEvent,
  createId,
  createLineDecoder,
  createRequest,
  createResponse,
  decodeLine,
  defaultSocketPath,
  encodeMessage,
  flushLineDecoder,
  serializeError,
  validateMessage,
};
