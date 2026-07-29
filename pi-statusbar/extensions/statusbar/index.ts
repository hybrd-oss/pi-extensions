/**
 * pi-statusbar: macOS menu bar status for pi sessions.
 *
 * Shows a pie icon in the menu bar aggregating all running pi sessions:
 * - orange filled pie: some session needs attention
 * - spinning pie: some session is working (animation configurable)
 * - dim pie: all idle
 *
 * Clicking the icon lists each session and its state.
 *
 * Architecture: a tiny Swift daemon (StatusBar.swift, compiled on first use)
 * owns the NSStatusItem and listens on ~/.pi/statusbar.sock. Each pi session
 * connects and streams {"name","state"} JSON lines; the connection itself is
 * the session's liveness. Daemon exits when the last session disconnects.
 *
 * Config: ~/.pi/agent/statusbar.json  { "animate": true }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOCK = join(os.homedir(), ".pi", "statusbar.sock");
const BIN_DIR = join(os.homedir(), ".pi", "agent", "statusbar");
const BIN = join(BIN_DIR, "pi-statusbar");
const SRC = join(dirname(fileURLToPath(import.meta.url)), "StatusBar.swift");

type State = "working" | "attention" | "idle";

export default function (pi: ExtensionAPI) {
	if (process.platform !== "darwin") return;

	let sock: net.Socket | null = null;
	let name = "pi";
	let state: State = "idle";
	let attempts = 0;
	let shuttingDown = false;
	let broken = false; // compile failed; stay quiet

	function ensureBinary(): boolean {
		try {
			if (existsSync(BIN) && statSync(BIN).mtimeMs >= statSync(SRC).mtimeMs) return true;
			mkdirSync(BIN_DIR, { recursive: true });
			const result = spawnSync("swiftc", ["-O", SRC, "-o", BIN], { timeout: 120_000 });
			return result.status === 0;
		} catch {
			return false;
		}
	}

	function send() {
		if (sock && !sock.destroyed) {
			sock.write(JSON.stringify({ name, state }) + "\n");
		}
	}

	function setState(next: State) {
		state = next;
		send();
	}

	function connect() {
		if (shuttingDown || broken || sock) return;
		const s = net.createConnection(SOCK);
		s.on("connect", () => {
			attempts = 0;
			sock = s;
			send();
		});
		s.on("error", () => {});
		s.on("close", () => {
			if (sock === s) sock = null;
			if (shuttingDown || broken) return;
			if (attempts >= 5) return; // give up until next state change
			attempts++;
			if (attempts === 1) {
				if (!ensureBinary()) {
					broken = true;
					return;
				}
				spawn(BIN, [], { detached: true, stdio: "ignore" }).unref();
			}
			setTimeout(connect, 500 * attempts).unref();
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		name = basename(ctx.cwd);
		connect();
	});

	pi.on("session_info_changed", async (event, ctx) => {
		name = event.name ?? basename(ctx.cwd);
		send();
	});

	pi.on("agent_start", async () => setState("working"));
	pi.on("agent_settled", async () => setState("attention"));

	pi.on("tool_execution_start", async (event) => {
		if (event.toolName === "ask_question") setState("attention");
	});
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName === "ask_question") setState("working");
	});

	pi.on("input", async () => {
		attempts = 0; // user activity: allow reconnect attempts again
		if (!sock) connect();
		setState("idle"); // agent_start flips to working right after, if a run starts
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		sock?.end();
		sock = null;
	});
}
