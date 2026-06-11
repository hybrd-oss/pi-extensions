(() => {
  const state = {
    view: "runs",
    status: undefined,
    selectedRunId: undefined,
    poll: undefined,
  };

  const content = document.getElementById("content");
  const notice = document.getElementById("notice");
  const connection = document.getElementById("connection");

  const params = new URLSearchParams(window.location.search);
  if (params.get("token")) {
    sessionStorage.setItem("porchestratorDashboardToken", params.get("token"));
    params.delete("token");
    const clean = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", clean || "/");
  }
  if (params.get("runId")) state.selectedRunId = params.get("runId");

  function token() { return sessionStorage.getItem("porchestratorDashboardToken"); }
  function headers() {
    const value = token();
    return value ? { authorization: `Bearer ${value}` } : {};
  }
  function h(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
  }
  function fmtDate(value) {
    if (!value) return "—";
    try { return new Date(value).toLocaleString(); } catch { return value; }
  }
  function statusClass(status) {
    const text = String(status || "");
    if (/failed|aborted|cancelled/.test(text)) return "bad";
    if (/attention|blocked|changes|warn/.test(text)) return "warn";
    if (/ready|merged|pass|clean/.test(text)) return "good";
    return "muted";
  }
  function showNotice(message) {
    notice.textContent = message || "";
    notice.classList.toggle("hidden", !message);
  }
  function setConnection(text, klass = "muted") {
    connection.textContent = text;
    connection.className = `pill ${klass}`;
  }
  async function api(path, options = {}) {
    const requestHeaders = { ...headers(), ...(options.headers || {}) };
    const response = await fetch(path, { ...options, headers: requestHeaders, credentials: "same-origin" });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json?.error?.message || `${response.status} ${response.statusText}`);
    return json;
  }
  function postJson(path, body) {
    return api(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function countPill(label, value, klass = "muted") {
    return `<span class="pill ${klass}">${h(label)}: <strong>${Number(value || 0)}</strong></span>`;
  }
  function runCounts(run) {
    return [
      countPill("queued", run.queuedTaskCount, "muted"),
      countPill("running", run.runningTaskCount, ""),
      countPill("attention", run.attentionTaskCount, run.attentionTaskCount ? "warn" : "muted"),
      countPill("ready", run.readyTaskCount, run.readyTaskCount ? "good" : "muted"),
      countPill("active", run.activeTaskCount, "muted"),
    ].join("");
  }
  function messageFormHtml(idPrefix, options = {}) {
    const scope = options.scope ? `<label>Target <select id="${idPrefix}-scope">
      <option value="running">running/idle tasks</option>
      <option value="attention">attention tasks</option>
      <option value="ready">ready tasks</option>
      <option value="active">all active tasks</option>
      <option value="all">all non-terminal tasks</option>
    </select></label>` : "";
    return `<form id="${idPrefix}-form" class="message-form">
      <div class="row">
        ${scope}
        <label>Mode <select id="${idPrefix}-mode"><option value="followUp">follow-up</option><option value="steer">steer</option></select></label>
        <label>Type <select id="${idPrefix}-type"><option value="inform">inform</option><option value="question">question</option><option value="decision">decision</option><option value="review_feedback">review feedback</option><option value="assignment">assignment</option></select></label>
      </div>
      <textarea id="${idPrefix}-message" rows="4" maxlength="32000" placeholder="Message to ${h(options.label || "worker")}"></textarea>
      <label class="checkbox"><input id="${idPrefix}-restart" type="checkbox"> restart/resume worker if needed</label>
      <div class="row"><button type="submit">Send message</button><span id="${idPrefix}-status" class="muted"></span></div>
    </form>`;
  }
  function readMessageForm(idPrefix) {
    const body = {
      message: document.getElementById(`${idPrefix}-message`)?.value || "",
      mode: document.getElementById(`${idPrefix}-mode`)?.value || "followUp",
      type: document.getElementById(`${idPrefix}-type`)?.value || "inform",
    };
    const scope = document.getElementById(`${idPrefix}-scope`)?.value;
    if (scope) body.scope = scope;
    if (document.getElementById(`${idPrefix}-restart`)?.checked) body.restartIfNeeded = true;
    return body;
  }
  function attachMessageForm(idPrefix, pathBuilder, options = {}) {
    const form = document.getElementById(`${idPrefix}-form`);
    if (!form) return;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const status = document.getElementById(`${idPrefix}-status`);
      const body = readMessageForm(idPrefix);
      if (!body.message.trim()) {
        if (status) status.textContent = "Message required.";
        return;
      }
      if (status) status.textContent = "Sending…";
      try {
        const result = await postJson(pathBuilder(body), body);
        if (status) {
          const sent = result.sentCount !== undefined ? `${result.sentCount}/${result.results?.length || result.sentCount}` : "1";
          status.textContent = result.summary || `Sent to ${sent} worker(s).`;
          status.className = result.ok === false ? "warn" : "good";
        }
        const message = document.getElementById(`${idPrefix}-message`);
        if (message && options.clear !== false) message.value = "";
        await refresh();
      } catch (error) {
        if (status) {
          status.textContent = error.message || String(error);
          status.className = "bad";
        }
      }
    });
  }

  function renderRuns() {
    const runs = state.status?.runs || [];
    if (!runs.length) {
      content.innerHTML = document.getElementById("empty-template").innerHTML;
      return;
    }
    content.innerHTML = `<section class="runs">${runs.map((run) => `
      <article class="panel run-card">
        <div class="row">
          <h2>${h(run.displayName || run.runName || run.runId)}</h2>
          <span class="pill ${statusClass(run.status)}">${h(run.statusLabel || run.status)}</span>
          ${state.status.activeRunId === run.runId ? `<span class="pill good">active</span>` : ""}
        </div>
        <div class="meta">
          <div><strong>Run:</strong> <code>${h(run.runId)}</code></div>
          <div><strong>Base:</strong> ${h(run.baseBranch || run.baseRef || "—")} ${run.baseCommit ? `<code>${h(String(run.baseCommit).slice(0, 12))}</code>` : ""}</div>
          <div><strong>Updated:</strong> ${h(fmtDate(run.updatedAt || run.createdAt))}</div>
          <div><strong>Integration:</strong> ${h(run.integration?.status || "—")} ${run.integration?.worktree ? `<span class="muted">${h(run.integration.worktree)}</span>` : ""}</div>
        </div>
        <div class="counts">${runCounts(run)}</div>
        <div class="row"><button class="link" data-open-run="${h(run.runId)}">Open run</button></div>
      </article>`).join("")}</section>`;
    content.querySelectorAll("[data-open-run]").forEach((button) => button.addEventListener("click", () => {
      state.selectedRunId = button.dataset.openRun;
      setView("active");
    }));
  }

  const columns = [
    ["queued", "Queued", ["planned", "creating_worktree", "setup", "queued"]],
    ["blocked", "Blocked", ["blocked"]],
    ["running", "Running", ["running", "idle"]],
    ["attention", "Needs attention", ["needs_attention"]],
    ["ready_review", "Ready for review", ["ready_for_review"]],
    ["changes", "Needs changes", ["needs_changes"]],
    ["ready_merge", "Ready to merge", ["ready_to_merge"]],
    ["merged", "Merged", ["merged"]],
    ["failed", "Failed/aborted", ["failed", "aborted", "cancelled"]],
  ];
  function columnFor(task) {
    const status = task.status;
    return columns.find(([, , statuses]) => statuses.includes(status))?.[0] || "queued";
  }
  function taskCard(task) {
    const klass = task.attention || ["blocked", "needs_attention", "needs_changes"].includes(task.status) ? "attention" : task.ready ? "ready" : "";
    return `<article class="task-card ${klass}" data-task="${h(task.taskId || task.id)}">
      <div class="task-title">${h(task.title || task.taskId || task.id)}</div>
      <div class="task-id"><code>${h(task.taskId || task.id)}</code></div>
      <div class="row">
        <span class="pill ${statusClass(task.status)}">${h(task.statusLabel || task.status)}</span>
        ${task.agent ? `<span class="pill muted">agent ${h(task.agent)}</span>` : ""}
        ${task.changedFilesText ? `<span class="pill muted">${h(task.changedFilesText)}</span>` : ""}
      </div>
      ${task.dependencies?.length ? `<div class="muted">deps: ${task.dependencies.map(h).join(", ")}</div>` : ""}
      ${task.blockedBy?.length ? `<div class="warn">blocked by: ${task.blockedBy.map(h).join(", ")}</div>` : ""}
    </article>`;
  }

  function renderActiveRun() {
    const runs = state.status?.runs || [];
    const run = runs.find((candidate) => candidate.runId === state.selectedRunId) || runs.find((candidate) => candidate.runId === state.status?.activeRunId) || runs[0];
    if (!run) return renderRuns();
    state.selectedRunId = run.runId;
    const buckets = Object.fromEntries(columns.map(([key]) => [key, []]));
    (run.tasks || []).forEach((task) => buckets[columnFor(task)].push(task));
    content.innerHTML = `
      <section class="panel">
        <div class="row"><h2>${h(run.displayName || run.runName || run.runId)}</h2><span class="pill ${statusClass(run.status)}">${h(run.statusLabel || run.status)}</span></div>
        <div class="grid two">
          <div class="meta">
            <div><strong>Run:</strong> <code>${h(run.runId)}</code></div>
            <div><strong>Base branch/ref:</strong> ${h(run.baseBranch || run.baseRef || "—")}</div>
            <div><strong>Base commit:</strong> <code>${h(String(run.baseCommit || "—").slice(0, 40))}</code></div>
            <div><strong>Worktree root:</strong> ${h(run.worktreeRoot || "—")}</div>
          </div>
          <div class="meta">
            <div><strong>Integration branch:</strong> ${h(run.integration?.branch || "—")}</div>
            <div><strong>Integration worktree:</strong> ${h(run.integration?.worktree || "—")}</div>
            <div><strong>Max concurrency:</strong> ${h(run.maxConcurrency || "—")}</div>
            <div><strong>Daemon:</strong> ${h(state.status?.daemonStatus?.status || "unknown")}</div>
          </div>
        </div>
        <div class="counts">${runCounts(run)}</div>
      </section>
      <section class="panel">
        <h3>Message run</h3>
        <p class="muted">Broadcast a safe follow-up/steer message using existing multitask_message semantics. Default target is currently running/idle workers.</p>
        ${messageFormHtml("run-message", { scope: true, label: "selected workers" })}
      </section>
      <section class="board" aria-label="Task board">
        ${columns.map(([key, label]) => `<div class="column"><h3><span>${h(label)}</span><span>${buckets[key].length}</span></h3>${buckets[key].map(taskCard).join("") || `<p class="muted">No tasks</p>`}</div>`).join("")}
      </section>`;
    content.querySelectorAll("[data-task]").forEach((card) => card.addEventListener("click", () => openTask(run.runId, card.dataset.task)));
    attachMessageForm("run-message", () => `/api/runs/${encodeURIComponent(run.runId)}/message`);
  }

  function renderDoctor() {
    content.innerHTML = `<section class="panel"><h2>Doctor</h2><p class="muted">Running checks…</p></section>`;
    api(`/api/doctor${state.selectedRunId ? `?runId=${encodeURIComponent(state.selectedRunId)}` : ""}`).then((doctor) => {
      content.innerHTML = `<section class="panel">
        <div class="row"><h2>Doctor</h2><span class="pill ${statusClass(doctor.status)}">${h(doctor.status || "unknown")}</span></div>
        ${doctor.warning ? `<p class="warn">${h(doctor.warning)}</p>` : ""}
        <div class="grid">${(doctor.checks || []).map((check) => `<article class="card">
          <div class="row"><h3>${h(check.title || check.id)}</h3><span class="pill ${statusClass(check.status)}">${h(check.status)}</span></div>
          <p>${h(check.summary)}</p>
          ${check.recovery?.length ? `<h4>Recovery</h4><ul>${check.recovery.map((item) => `<li>${h(item)}</li>`).join("")}</ul>` : ""}
          ${check.details ? `<pre>${h(typeof check.details === "string" ? check.details : JSON.stringify(check.details, null, 2))}</pre>` : ""}
        </article>`).join("")}</div>
      </section>`;
    }).catch(showError);
  }

  function renderAgents() {
    content.innerHTML = `<section class="panel"><h2>Agents</h2><p class="muted">Loading registry…</p></section>`;
    api("/api/agents").then((result) => {
      content.innerHTML = `<section class="panel">
        <h2>Agents</h2>
        <p class="muted">Viewing project-local agents here does not trust them or enable runtime controls.</p>
        ${result.warning ? `<p class="warn">${h(result.warning)}</p>` : ""}
        <table class="table"><thead><tr><th>Name</th><th>Source</th><th>Trust</th><th>Runtime summary</th><th>Description</th></tr></thead><tbody>
          ${(result.agents || []).map((agent) => `<tr>
            <td><code>${h(agent.name)}</code></td>
            <td>${h(agent.source)}${agent.projectLocal ? ` <span class="pill warn">project-local</span>` : ""}</td>
            <td>${agent.projectLocal ? `<span class="warn">not trusted by viewing</span>` : `<span class="good">trusted source</span>`}</td>
            <td>${[agent.model && `model ${agent.model}`, agent.thinking && `thinking ${agent.thinking}`, agent.tools?.length && `${agent.tools.length} tools`, agent.skills?.length && `${agent.skills.length} skills`].filter(Boolean).map(h).join(" · ") || "—"}</td>
            <td>${h(agent.description || "")}</td>
          </tr>`).join("")}
        </tbody></table>
      </section>`;
    }).catch(showError);
  }

  function renderConfig() {
    content.innerHTML = `<section class="panel"><h2>Settings/Config</h2><p class="muted">Loading…</p></section>`;
    api("/api/config").then((config) => {
      content.innerHTML = `<section class="panel">
        <h2>Settings/Config</h2>
        <div class="meta">
          <div><strong>Config path:</strong> ${h(config.path)}</div>
          <div><strong>Worktree root:</strong> ${h(config.worktrees?.root)}</div>
          <div><strong>Worker runner:</strong> ${h(config.workers?.runner)}</div>
          <div><strong>Max concurrency:</strong> ${h(config.workers?.maxConcurrency || "default")}</div>
          <div><strong>Worker tools:</strong> ${h((config.workers?.tools || []).join(", "))}</div>
        </div>
        <h3>Scripts</h3>
        <table class="table"><thead><tr><th>ID</th><th>Name</th><th>Command</th><th>Required</th></tr></thead><tbody>
          ${Object.entries(config.scripts || {}).map(([id, script]) => `<tr><td><code>${h(id)}</code></td><td>${h(script.name)}</td><td><code>${h(script.command)}</code></td><td>${h(script.required)}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No named scripts configured.</td></tr>`}
        </tbody></table>
      </section>`;
    }).catch(showError);
  }

  async function openTask(runId, taskId) {
    const existing = document.querySelector(".drawer");
    if (existing) existing.remove();
    const drawer = document.createElement("aside");
    drawer.className = "drawer";
    drawer.innerHTML = `<div class="drawer-header"><h2>${h(taskId)}</h2><button id="close-drawer">Close</button></div><p class="muted">Loading task detail…</p>`;
    document.body.appendChild(drawer);
    drawer.querySelector("#close-drawer").addEventListener("click", () => drawer.remove());
    try {
      const task = await api(`/api/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}`);
      drawer.innerHTML = `<div class="drawer-header"><div><h2>${h(task.title || task.taskId)}</h2><div class="muted"><code>${h(runId)}/${h(task.taskId)}</code></div></div><button id="close-drawer">Close</button></div>
        <section class="card"><h3>Overview</h3><div class="meta">
          <div><strong>Status:</strong> <span class="${statusClass(task.status)}">${h(task.status)}</span></div>
          <div><strong>Agent/model:</strong> ${h([task.agent, task.model].filter(Boolean).join(" / ") || "—")}</div>
          <div><strong>Branch:</strong> ${h(task.branch || "—")}</div>
          <div><strong>Worktree:</strong> ${h(task.worktree || "—")}</div>
          <div><strong>Session dir:</strong> ${h(task.sessionDir || "—")}</div>
          <div><strong>Dependencies:</strong> ${h((task.dependencies || []).join(", ") || "—")}</div>
        </div></section>
        <section class="card"><h3>Message worker</h3>${messageFormHtml("task-message", { label: task.taskId })}</section>
        <section class="card"><h3>Assignment prompt tail</h3><pre>${h(task.assignment?.promptTail?.text || "")}</pre>${task.assignment?.promptTail?.truncated ? `<p class="warn">Prompt truncated for display.</p>` : ""}</section>
        <section class="card"><h3>Transcript tail (${task.transcriptTail?.length || 0})</h3><pre>${h((task.transcriptTail || []).map((entry) => JSON.stringify(entry)).join("\n"))}</pre></section>
        <section class="card"><h3>Diff summary</h3>${renderDiff(task.diff)}</section>
        <section class="card"><h3>Validation</h3><pre>${h(JSON.stringify(task.validation || [], null, 2))}</pre></section>
        <section class="card"><h3>Review</h3><pre>${h(JSON.stringify(task.review || {}, null, 2))}</pre></section>
        <section class="card"><h3>Events</h3><pre>${h((task.recentEvents || []).map((entry) => JSON.stringify(entry)).join("\n"))}</pre></section>
        <section class="card"><h3>Recovery</h3><pre>${h(JSON.stringify(task.recovery || task.worker || {}, null, 2))}</pre></section>`;
      drawer.querySelector("#close-drawer").addEventListener("click", () => drawer.remove());
      attachMessageForm("task-message", () => `/api/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(task.taskId)}/message`);
    } catch (error) {
      drawer.innerHTML = `<div class="drawer-header"><h2>${h(taskId)}</h2><button id="close-drawer">Close</button></div><p class="bad">${h(error.message)}</p>`;
      drawer.querySelector("#close-drawer").addEventListener("click", () => drawer.remove());
    }
  }

  function renderDiff(diff) {
    if (!diff || diff.error) return `<p class="muted">${h(diff?.error?.message || "No diff available.")}</p>`;
    return `<div class="meta">
      <div><strong>Changed files:</strong> ${h(diff.changedFileCount ?? diff.changedFiles?.length ?? 0)}${diff.changedFilesTruncated ? " (truncated)" : ""}</div>
      <div><strong>Committed:</strong> ${h(diff.committed?.shortstat || "—")}</div>
      <div><strong>Working tree:</strong> ${h(diff.workingTree?.shortstat || "—")}</div>
    </div><pre>${h((diff.changedFiles || []).map((file) => `${file.status || "?"} ${file.path}${file.oldPath ? ` from ${file.oldPath}` : ""}`).join("\n") || diff.summary?.text || "No changed files detected.")}</pre>`;
  }

  function showError(error) {
    setConnection("error", "bad");
    showNotice(error.message || String(error));
  }
  function isEditingMessageForm() {
    const active = document.activeElement;
    return Boolean(active && active.closest && active.closest(".message-form"));
  }
  function setView(view) {
    state.view = view;
    document.querySelectorAll(".tabs button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    render();
  }
  function render() {
    showNotice(state.status?.warnings?.join("\n") || "");
    if (state.view === "runs") return renderRuns();
    if (state.view === "active") return renderActiveRun();
    if (state.view === "doctor") return renderDoctor();
    if (state.view === "agents") return renderAgents();
    if (state.view === "config") return renderConfig();
  }
  async function refresh() {
    try {
      state.status = await api("/api/status");
      if (!state.selectedRunId) state.selectedRunId = state.status.activeRunId || state.status.runs?.[0]?.runId;
      setConnection(`updated ${new Date().toLocaleTimeString()}`, "good");
      if ((state.view === "runs" || state.view === "active") && !isEditingMessageForm()) render();
    } catch (error) {
      showError(error);
    }
  }

  document.querySelectorAll(".tabs button").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  refresh().then(() => setView(state.selectedRunId ? "active" : "runs"));
  state.poll = setInterval(refresh, 5000);
})();
