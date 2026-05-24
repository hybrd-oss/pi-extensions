const net = require("node:net");
const { getRepoInfo } = require("../git.js");
const { cleanupStaleDaemonFiles, formatDaemonStatus, getDaemonStatus } = require("./lifecycle.js");
const {
  METHODS,
  createLineDecoder,
  createRequest,
  defaultSocketPath,
  encodeMessage,
} = require("./daemon-protocol.js");

class MultitaskClient {
  constructor(options = {}) {
    this.repoRoot = options.repoRoot;
    this.cwd = options.cwd || process.cwd();
    this.socketPath = options.socketPath;
    this.timeoutMs = options.timeoutMs || 30_000;
  }

  async resolveSocketPath() {
    if (this.socketPath) return this.socketPath;
    if (!this.repoRoot) {
      const repo = await getRepoInfo(this.cwd);
      this.repoRoot = repo.root;
    }
    this.socketPath = defaultSocketPath(this.repoRoot);
    return this.socketPath;
  }

  async request(method, params = {}, options = {}) {
    const socketPath = await this.resolveSocketPath();
    const request = createRequest(method, params, options);
    const timeoutMs = options.timeoutMs || this.timeoutMs;

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let settled = false;
      let timeout;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        socket.destroy();
        fn(value);
      };

      const onMessage = (message) => {
        if (message.kind === "event") return;
        if (message.id !== request.id) return;
        if (message.ok) finish(resolve, message.result);
        else {
          const error = new Error(message.error?.message || "Multitask daemon request failed.");
          error.remote = message.error;
          finish(reject, error);
        }
      };

      const onErrorLine = (error) => finish(reject, error);
      const decode = createLineDecoder(onMessage, onErrorLine);

      socket.on("connect", () => socket.write(encodeMessage(request)));
      socket.on("data", decode);
      socket.on("error", (error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        socket.destroy();
        (async () => {
          if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
            const status = this.repoRoot ? await getDaemonStatus(this.repoRoot, { socketPath }) : undefined;
            if (status) await cleanupStaleDaemonFiles(this.repoRoot, { status }).catch(() => {});
            error.message = [
              `Multitask daemon is not reachable at ${socketPath}. Start the daemon before using the client.`,
              status ? formatDaemonStatus(status) : undefined,
            ].filter(Boolean).join("\n");
          }
        })().then(() => reject(error), (statusError) => {
          error.message = `${error.message}\nFailed checking daemon status: ${statusError.message}`;
          reject(error);
        });
      });
      socket.on("close", () => {
        if (!settled) finish(reject, new Error(`Multitask daemon closed the connection before responding to ${method}.`));
      });

      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          finish(reject, new Error(`Timed out waiting for multitask daemon response to ${method}.`));
        }, timeoutMs);
      }
    });
  }

  ping(params = {}) {
    return this.request(METHODS.PING, params);
  }

  start(params) {
    return this.request(METHODS.START, params);
  }

  spawn(params) {
    return this.request(METHODS.SPAWN, params);
  }

  message(params) {
    return this.request(METHODS.MESSAGE, params);
  }

  status(params = {}) {
    return this.request(METHODS.STATUS, params);
  }

  logs(params) {
    return this.request(METHODS.LOGS, params);
  }

  diff(params) {
    return this.request(METHODS.DIFF, params);
  }

  review(params) {
    return this.request(METHODS.REVIEW, params);
  }

  merge(params) {
    return this.request(METHODS.MERGE, params);
  }

  apply(params) {
    return this.request(METHODS.APPLY, params);
  }

  cancel(params) {
    return this.request(METHODS.CANCEL, params);
  }

  cleanup(params) {
    return this.request(METHODS.CLEANUP, params);
  }

  shutdown(params = {}) {
    return this.request(METHODS.SHUTDOWN, params);
  }
}

function createClient(options = {}) {
  return new MultitaskClient(options);
}

module.exports = {
  MultitaskClient,
  createClient,
};
