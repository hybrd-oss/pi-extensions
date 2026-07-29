// pi-statusbar daemon: one NSStatusItem aggregating all running pi sessions.
// Sessions connect via unix socket and send JSON lines: {"name": "...", "state": "working"|"attention"|"idle"}
// A session = a socket connection; disconnect removes it. Daemon exits when the last session leaves.

import AppKit
import Foundation

let sockPath = ("~/.pi/statusbar.sock" as NSString).expandingTildeInPath

// MARK: - Config

func loadAnimate() -> Bool {
	let path = ("~/.pi/agent/statusbar.json" as NSString).expandingTildeInPath
	guard let data = FileManager.default.contents(atPath: path),
		let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
		let animate = obj["animate"] as? Bool
	else { return true }
	return animate
}

// MARK: - Socket helpers

func sockaddrUn(_ path: String) -> sockaddr_un {
	var addr = sockaddr_un()
	addr.sun_family = sa_family_t(AF_UNIX)
	path.withCString { src in
		withUnsafeMutablePointer(to: &addr.sun_path) { dst in
			dst.withMemoryRebound(to: CChar.self, capacity: 104) { _ = strncpy($0, src, 103) }
		}
	}
	return addr
}

func makeListener() -> Int32 {
	let fd = socket(AF_UNIX, SOCK_STREAM, 0)
	guard fd >= 0 else { exit(1) }
	var addr = sockaddrUn(sockPath)
	let len = socklen_t(MemoryLayout<sockaddr_un>.size)
	func tryBind() -> Bool {
		withUnsafePointer(to: &addr) {
			$0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) == 0 }
		}
	}
	if !tryBind() {
		// Socket file exists. Live daemon? Try connecting.
		let probe = socket(AF_UNIX, SOCK_STREAM, 0)
		let connected = withUnsafePointer(to: &addr) {
			$0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(probe, $0, len) == 0 }
		}
		close(probe)
		if connected { exit(0) }  // another daemon is running
		unlink(sockPath)
		guard tryBind() else { exit(1) }
	}
	guard listen(fd, 16) == 0 else { exit(1) }
	return fd
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
	struct Session { var name: String; var state: String }

	var sessions: [Int32: Session] = [:]  // fd -> session
	var readers: [Int32: DispatchSourceRead] = [:]
	var buffers: [Int32: Data] = [:]
	var everConnected = false

	var statusItem: NSStatusItem!
	let animate = loadAnimate()
	var spinTimer: Timer?
	var rotation: CGFloat = 90
	var acceptSource: DispatchSourceRead?

	func applicationDidFinishLaunching(_ notification: Notification) {
		statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
		statusItem.menu = NSMenu()
		updateUI()
		startListening()
	}

	// MARK: Listening

	func startListening() {
		let listenFd = makeListener()
		let acceptSource = DispatchSource.makeReadSource(fileDescriptor: listenFd, queue: .main)
		acceptSource.setEventHandler { [weak self] in
			let clientFd = accept(listenFd, nil, nil)
			guard clientFd >= 0 else { return }
			self?.addClient(clientFd)
		}
		acceptSource.resume()
		self.acceptSource = acceptSource
	}

	func addClient(_ fd: Int32) {
		everConnected = true
		sessions[fd] = Session(name: "pi", state: "idle")
		buffers[fd] = Data()
		let reader = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
		reader.setEventHandler { [weak self] in self?.readClient(fd) }
		reader.setCancelHandler { close(fd) }
		readers[fd] = reader
		reader.resume()
		updateUI()
	}

	func readClient(_ fd: Int32) {
		var chunk = [UInt8](repeating: 0, count: 4096)
		let n = read(fd, &chunk, chunk.count)
		if n <= 0 { return removeClient(fd) }
		buffers[fd]?.append(contentsOf: chunk[0..<n])
		while let buf = buffers[fd], let nl = buf.firstIndex(of: 0x0A) {
			let line = buf[buf.startIndex..<nl]
			buffers[fd] = buf[buf.index(after: nl)...]
			if let obj = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] {
				if let name = obj["name"] as? String { sessions[fd]?.name = name }
				if let state = obj["state"] as? String { sessions[fd]?.state = state }
			}
		}
		updateUI()
	}

	func removeClient(_ fd: Int32) {
		readers.removeValue(forKey: fd)?.cancel()
		sessions.removeValue(forKey: fd)
		buffers.removeValue(forKey: fd)
		updateUI()
		if sessions.isEmpty && everConnected {
			// Grace period: /reload and session switches reconnect within moments.
			DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
				guard let self, self.sessions.isEmpty else { return }
				unlink(sockPath)
				NSApp.terminate(nil)
			}
		}
	}

	// MARK: UI

	var aggregateState: String {
		let states = sessions.values.map(\.state)
		if states.contains("attention") { return "attention" }
		if states.contains("working") { return "working" }
		return "idle"
	}

	func updateUI() {
		let state = aggregateState
		if state == "working" && animate {
			if spinTimer == nil {
				spinTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
					guard let self else { return }
					self.rotation -= 14
					self.statusItem.button?.image = self.pieImage(for: "working")
				}
			}
		} else {
			spinTimer?.invalidate()
			spinTimer = nil
			rotation = 90
		}
		statusItem.button?.image = pieImage(for: state)
		rebuildMenu()
	}

	func pieImage(for state: String) -> NSImage {
		let alpha: CGFloat = state == "idle" ? 0.4 : 1.0
		let color: NSColor? = state == "attention" ? .systemOrange : nil
		let start = rotation
		let img = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
			let c = NSPoint(x: rect.midX, y: rect.midY)
			let r: CGFloat = 7.5
			let fill = (color ?? .black).withAlphaComponent(alpha)
			fill.setFill()
			fill.setStroke()
			let circle = NSBezierPath(ovalIn: NSRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
			circle.lineWidth = 1.5
			circle.stroke()
			// pie with one slice missing (72 degrees)
			let wedge = NSBezierPath()
			wedge.move(to: c)
			wedge.appendArc(withCenter: c, radius: r - 0.5, startAngle: start, endAngle: start + 288)
			wedge.close()
			wedge.fill()
			return true
		}
		img.isTemplate = (color == nil)
		return img
	}

	func rebuildMenu() {
		guard let menu = statusItem.menu else { return }
		menu.removeAllItems()
		let dots = ["working": "🔵", "attention": "🟠", "idle": "⚪️"]
		for session in sessions.values.sorted(by: { $0.name < $1.name }) {
			let dot = dots[session.state] ?? "⚪️"
			let item = NSMenuItem(title: "\(dot) \(session.name) — \(session.state)", action: nil, keyEquivalent: "")
			item.isEnabled = false
			menu.addItem(item)
		}
		if sessions.isEmpty {
			let item = NSMenuItem(title: "No sessions", action: nil, keyEquivalent: "")
			item.isEnabled = false
			menu.addItem(item)
		}
		menu.addItem(.separator())
		menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
	}
}

signal(SIGPIPE, SIG_IGN)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
