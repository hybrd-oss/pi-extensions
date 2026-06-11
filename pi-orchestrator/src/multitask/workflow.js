const { slugify } = require("../utils.js");

const WORKFLOW_SCHEMA_VERSION = 1;

const WORKFLOW_NODE_KINDS = Object.freeze({
  SPAWN: "spawn",
  SEQUENCE: "sequence",
  PARALLEL: "parallel",
  JOIN: "join",
  LOOP: "loop",
});

class WorkflowValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "WorkflowValidationError";
    this.code = "ERR_MULTITASK_WORKFLOW_INVALID";
    this.details = details;
  }
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function compact(values) {
  return asArray(values).filter((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function taskIdFromValue(value) {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (value && typeof value === "object") return String(value.id || value.taskId || value.name || value.title || "").trim();
  return "";
}

function taskIdsFromTasks(tasks = []) {
  return unique(asArray(tasks).map(taskIdFromValue));
}

function createTaskResolver(taskIds = []) {
  const canonical = unique(taskIds);
  const idSet = new Set(canonical);
  const slugToId = new Map();
  for (const id of canonical) {
    const slug = slugify(id, id);
    if (!slugToId.has(slug)) slugToId.set(slug, id);
  }

  return {
    taskIds: canonical,
    idSet,
    resolve(value) {
      const raw = taskIdFromValue(value);
      if (!raw) return "";
      if (idSet.has(raw)) return raw;
      const slug = slugify(raw, raw);
      return slugToId.get(slug) || slug;
    },
  };
}

function normalizeDependencyEdges(dependencies = [], resolver = createTaskResolver([]), source = "dependencies") {
  const edges = [];
  for (const [index, item] of asArray(dependencies).entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new WorkflowValidationError(
        `Invalid multitask dependency at ${source}[${index}]: expected { before, after }.`,
        { source, index, item },
      );
    }
    const before = resolver.resolve(item.before);
    const after = resolver.resolve(item.after);
    if (!before || !after) {
      throw new WorkflowValidationError(
        `Invalid multitask dependency at ${source}[${index}]: both before and after task ids are required.`,
        { source, index, item },
      );
    }
    edges.push({
      before,
      after,
      source: item.source || source,
      label: item.label,
    });
  }
  return dedupeEdges(edges);
}

function edgeKey(edge) {
  return `${edge.before}\u0000${edge.after}`;
}

function dedupeEdges(edges = []) {
  const seen = new Set();
  const result = [];
  for (const edge of edges || []) {
    if (!edge || !edge.before || !edge.after) continue;
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      before: String(edge.before),
      after: String(edge.after),
      ...(edge.source ? { source: edge.source } : {}),
      ...(edge.label ? { label: edge.label } : {}),
    });
  }
  return result;
}

function dependencyEdgesBetween(beforeIds, afterIds, source) {
  const edges = [];
  for (const before of beforeIds || []) {
    for (const after of afterIds || []) {
      edges.push({ before, after, source });
    }
  }
  return edges;
}

function nodePath(path, label) {
  return path ? `${path}.${label}` : label;
}

function workflowNodeKind(node) {
  if (typeof node === "string" || typeof node === "number") return WORKFLOW_NODE_KINDS.SPAWN;
  if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
  if (node.kind) return String(node.kind).trim().toLowerCase();
  if (node.type) return String(node.type).trim().toLowerCase();
  if (node.task || node.taskId || node.id || node.tasks) return WORKFLOW_NODE_KINDS.SPAWN;
  if (node.steps || node.nodes || node.children) return WORKFLOW_NODE_KINDS.SEQUENCE;
  return undefined;
}

function childNodesFor(node, preferredKeys = ["steps", "nodes", "children"]) {
  for (const key of preferredKeys) {
    if (Array.isArray(node?.[key])) return node[key];
  }
  return [];
}

function spawnTaskRefs(node) {
  if (typeof node === "string" || typeof node === "number") return [node];
  if (!node || typeof node !== "object") return [];
  return compact([
    ...asArray(node.task),
    ...asArray(node.taskId),
    ...(node.id && !node.kind ? asArray(node.id) : []),
    ...asArray(node.tasks),
  ]);
}

function parseSpawnNode(node, context, path) {
  const taskIds = unique(spawnTaskRefs(node).map((ref) => context.resolver.resolve(ref)));
  if (taskIds.length === 0) {
    throw new WorkflowValidationError(`Workflow ${path} spawn node must reference task or tasks.`, { path, node });
  }
  return {
    taskIds,
    starts: taskIds,
    ends: taskIds,
    dependencies: [],
    tree: {
      id: path,
      kind: WORKFLOW_NODE_KINDS.SPAWN,
      tasks: taskIds,
      ...(node && typeof node === "object" && node.label ? { label: String(node.label) } : {}),
    },
  };
}

function parseParallelNode(node, context, path) {
  const children = [];
  if (Array.isArray(node.tasks)) children.push({ kind: WORKFLOW_NODE_KINDS.SPAWN, tasks: node.tasks });
  children.push(...childNodesFor(node, ["steps", "nodes", "branches", "children"]));
  if (children.length === 0) {
    throw new WorkflowValidationError(`Workflow ${path} parallel node must include tasks, steps, nodes, branches, or children.`, { path, node });
  }

  const parsed = children.map((child, index) => parseWorkflowNode(child, context, nodePath(path, `branch${index + 1}`)));
  return {
    taskIds: unique(parsed.flatMap((child) => child.taskIds)),
    starts: unique(parsed.flatMap((child) => child.starts)),
    ends: unique(parsed.flatMap((child) => child.ends)),
    dependencies: dedupeEdges(parsed.flatMap((child) => child.dependencies)),
    tree: {
      id: path,
      kind: WORKFLOW_NODE_KINDS.PARALLEL,
      children: parsed.map((child) => child.tree),
      ...(node.label ? { label: String(node.label) } : {}),
    },
  };
}

function parseSequenceNode(node, context, path) {
  let children = childNodesFor(node, ["steps", "nodes", "children"]);
  if (children.length === 0 && Array.isArray(node.tasks)) {
    children = node.tasks.map((task) => ({ kind: WORKFLOW_NODE_KINDS.SPAWN, task }));
  }
  if (children.length === 0) {
    throw new WorkflowValidationError(`Workflow ${path} sequence node must include steps, nodes, children, or tasks.`, { path, node });
  }

  const parsed = children.map((child, index) => parseWorkflowNode(child, context, nodePath(path, `step${index + 1}`)));
  const dependencies = parsed.flatMap((child) => child.dependencies);
  for (let index = 1; index < parsed.length; index += 1) {
    const previousEnds = parsed[index - 1].ends;
    const currentStarts = parsed[index].starts;
    dependencies.push(...dependencyEdgesBetween(previousEnds, currentStarts, nodePath(path, `step${index}->step${index + 1}`)));
  }

  const firstWithStarts = parsed.find((child) => child.starts.length > 0);
  const lastWithEnds = [...parsed].reverse().find((child) => child.ends.length > 0);
  return {
    taskIds: unique(parsed.flatMap((child) => child.taskIds)),
    starts: firstWithStarts ? firstWithStarts.starts : [],
    ends: lastWithEnds ? lastWithEnds.ends : [],
    dependencies: dedupeEdges(dependencies),
    tree: {
      id: path,
      kind: WORKFLOW_NODE_KINDS.SEQUENCE,
      children: parsed.map((child) => child.tree),
      ...(node.label ? { label: String(node.label) } : {}),
    },
  };
}

function joinRefs(node, keys) {
  return unique(keys.flatMap((key) => asArray(node?.[key])).map(taskIdFromValue).filter(Boolean));
}

function parseJoinNode(node, context, path) {
  const after = unique(joinRefs(node, ["after", "from", "dependencies", "prerequisites"]).map((ref) => context.resolver.resolve(ref)));
  const before = unique(joinRefs(node, ["before", "to", "task", "taskId", "tasks"]).map((ref) => context.resolver.resolve(ref)));
  if (after.length === 0 && before.length === 0) {
    throw new WorkflowValidationError(`Workflow ${path} join node must name after/from prerequisites or before/to task targets.`, { path, node });
  }

  return {
    taskIds: unique([...after, ...before]),
    starts: before.length > 0 ? before : after,
    ends: before.length > 0 ? before : after,
    dependencies: before.length > 0 ? dependencyEdgesBetween(after, before, path) : [],
    tree: {
      id: path,
      kind: WORKFLOW_NODE_KINDS.JOIN,
      after,
      before,
      ...(node.label ? { label: String(node.label) } : {}),
    },
  };
}

function parseLoopNode(node, context, path) {
  let children = childNodesFor(node, ["steps", "nodes", "children", "body"]);
  if (children.length === 0 && node.body && !Array.isArray(node.body)) children = [node.body];
  if (children.length === 0) {
    throw new WorkflowValidationError(
      `Workflow ${path} loop node must include a finite body in steps, nodes, children, or body. Runtime back-edges are not supported in Segment 7.`,
      { path, node },
    );
  }
  const parsed = children.length === 1
    ? parseWorkflowNode(children[0], context, nodePath(path, "body"))
    : parseSequenceNode({ kind: WORKFLOW_NODE_KINDS.SEQUENCE, steps: children }, context, nodePath(path, "body"));

  return {
    taskIds: parsed.taskIds,
    starts: parsed.starts,
    ends: parsed.ends,
    dependencies: parsed.dependencies,
    tree: {
      id: path,
      kind: WORKFLOW_NODE_KINDS.LOOP,
      mode: "finite_body_only",
      maxIterations: Number.isFinite(Number(node.maxIterations || node.iterations))
        ? Math.max(1, Math.floor(Number(node.maxIterations || node.iterations)))
        : undefined,
      note: "Segment 7 records loop intent and validates the finite body; it does not add runtime back-edges.",
      child: parsed.tree,
      ...(node.label ? { label: String(node.label) } : {}),
    },
  };
}

function parseWorkflowNode(node, context, path = "workflow") {
  const kind = workflowNodeKind(node);
  if (!kind) {
    throw new WorkflowValidationError(`Workflow ${path} node is missing a supported kind.`, { path, node });
  }

  switch (kind) {
    case WORKFLOW_NODE_KINDS.SPAWN:
      return parseSpawnNode(node, context, path);
    case WORKFLOW_NODE_KINDS.SEQUENCE:
      return parseSequenceNode(node, context, path);
    case WORKFLOW_NODE_KINDS.PARALLEL:
      return parseParallelNode(node, context, path);
    case WORKFLOW_NODE_KINDS.JOIN:
      return parseJoinNode(node, context, path);
    case WORKFLOW_NODE_KINDS.LOOP:
      return parseLoopNode(node, context, path);
    default:
      throw new WorkflowValidationError(
        `Unsupported multitask workflow node kind "${kind}" at ${path}. Supported kinds: ${Object.values(WORKFLOW_NODE_KINDS).join(", ")}.`,
        { path, kind, node },
      );
  }
}

function validateDependencyGraph({ taskIds = [], dependencies = [] } = {}) {
  const canonicalTaskIds = unique(taskIds);
  const idSet = new Set(canonicalTaskIds);
  const edges = dedupeEdges(dependencies);
  const unknown = unique(edges.flatMap((edge) => [edge.before, edge.after]).filter((id) => !idSet.has(id)));
  if (unknown.length > 0) {
    throw new WorkflowValidationError(
      `Invalid multitask workflow dependencies: unknown task id(s): ${unknown.join(", ")}. Known tasks: ${canonicalTaskIds.join(", ") || "none"}.`,
      { unknownTaskIds: unknown, taskIds: canonicalTaskIds, dependencies: edges },
    );
  }

  const selfEdges = edges.filter((edge) => edge.before === edge.after);
  if (selfEdges.length > 0) {
    throw new WorkflowValidationError(
      `Invalid multitask workflow dependencies: task(s) cannot depend on themselves: ${unique(selfEdges.map((edge) => edge.before)).join(", ")}.`,
      { selfEdges },
    );
  }

  const cycle = findDependencyCycle(canonicalTaskIds, edges);
  if (cycle) {
    throw new WorkflowValidationError(
      `Invalid multitask workflow dependencies: cycle detected (${cycle.join(" -> ")}). Remove or reverse one of these dependency edges.`,
      { cycle, dependencies: edges },
    );
  }

  return { taskIds: canonicalTaskIds, dependencies: edges };
}

function findDependencyCycle(taskIds = [], dependencies = []) {
  const adjacency = new Map(taskIds.map((id) => [id, []]));
  for (const edge of dependencies || []) {
    if (!adjacency.has(edge.before)) adjacency.set(edge.before, []);
    adjacency.get(edge.before).push(edge.after);
  }

  const state = new Map();
  const stack = [];
  const stackIndex = new Map();

  function visit(id) {
    state.set(id, "visiting");
    stackIndex.set(id, stack.length);
    stack.push(id);

    for (const next of adjacency.get(id) || []) {
      if (state.get(next) === "visiting") {
        return [...stack.slice(stackIndex.get(next)), next];
      }
      if (!state.has(next)) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, "visited");
    return undefined;
  }

  for (const id of taskIds || []) {
    if (!state.has(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return undefined;
}

function computeDependencyWaves(taskIds = [], dependencies = []) {
  const ids = unique(taskIds);
  const adjacency = new Map(ids.map((id) => [id, []]));
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const edge of dedupeEdges(dependencies)) {
    if (!adjacency.has(edge.before) || !indegree.has(edge.after)) continue;
    adjacency.get(edge.before).push(edge.after);
    indegree.set(edge.after, indegree.get(edge.after) + 1);
  }

  const remaining = new Set(ids);
  const waves = [];
  const taskWaves = {};
  while (remaining.size > 0) {
    const wave = ids.filter((id) => remaining.has(id) && indegree.get(id) === 0);
    if (wave.length === 0) {
      // validateDependencyGraph should catch this first. Keep a safe guard for
      // callers that only ask for waves.
      throw new WorkflowValidationError("Cannot compute multitask dependency waves because the graph contains a cycle.", { taskIds: ids, dependencies });
    }
    const waveIndex = waves.length;
    waves.push(wave);
    for (const id of wave) {
      remaining.delete(id);
      taskWaves[id] = waveIndex;
      for (const next of adjacency.get(id) || []) {
        indegree.set(next, indegree.get(next) - 1);
      }
    }
  }
  return { waves, taskWaves };
}

function escapeMermaidLabel(value) {
  return String(value).replace(/"/g, "#quot;");
}

function mermaidNodeId(taskId) {
  const slug = String(taskId || "task").replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[a-zA-Z_]/.test(slug) ? slug : `task_${slug}`;
}

function exportMermaid({ taskIds = [], dependencies = [], title } = {}) {
  const ids = unique(taskIds);
  const lines = ["flowchart TD"];
  if (title) lines.push(`  %% ${String(title).replace(/\n/g, " ")}`);
  for (const id of ids) {
    lines.push(`  ${mermaidNodeId(id)}["${escapeMermaidLabel(id)}"]`);
  }
  for (const edge of dedupeEdges(dependencies)) {
    lines.push(`  ${mermaidNodeId(edge.before)} --> ${mermaidNodeId(edge.after)}`);
  }
  return `${lines.join("\n")}\n`;
}

function summarizeWorkflow(plan) {
  const edgeCount = plan.dependencies.length;
  const waveSummary = plan.waves.map((wave, index) => `wave ${index + 1}: ${wave.join(", ")}`).join("; ");
  return `${plan.taskIds.length} task(s), ${edgeCount} dependenc${edgeCount === 1 ? "y" : "ies"}${waveSummary ? ` (${waveSummary})` : ""}`;
}

function compileWorkflow(input = {}, options = {}) {
  const taskIds = taskIdsFromTasks(options.taskIds || input.taskIds || input.tasks || []);
  const resolver = createTaskResolver(taskIds);
  const explicitDependencies = normalizeDependencyEdges(input.dependencies || [], resolver, "dependencies");
  let parsed;
  if (input.workflow) parsed = parseWorkflowNode(input.workflow, { resolver }, "workflow");

  const workflowDependencies = parsed ? parsed.dependencies : [];
  const dependencies = dedupeEdges([...explicitDependencies, ...workflowDependencies]);
  validateDependencyGraph({ taskIds, dependencies });
  const { waves, taskWaves } = computeDependencyWaves(taskIds, dependencies);
  const tree = parsed?.tree || (dependencies.length > 0 ? {
    id: "dependencies",
    kind: "dependencies",
    edges: dependencies.map((edge) => ({ before: edge.before, after: edge.after })),
  } : undefined);

  const plan = {
    kind: "pi-multitask-workflow",
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    taskIds,
    dependencies,
    waves,
    taskWaves,
    tree,
    debug: {
      explicitDependencyCount: explicitDependencies.length,
      workflowDependencyCount: workflowDependencies.length,
      hasWorkflowInput: Boolean(input.workflow),
      hasDependencyInput: explicitDependencies.length > 0,
    },
  };
  plan.mermaid = exportMermaid(plan);
  plan.summary = summarizeWorkflow(plan);
  return plan;
}

function hasWorkflowInput(input = {}) {
  return Boolean(input.workflow) || asArray(input.dependencies).length > 0;
}

function workflowManifestPatch(input = {}, tasks = []) {
  if (!hasWorkflowInput(input)) return {};
  const plan = compileWorkflow({ ...input, tasks });
  return {
    dependencies: plan.dependencies.map((edge) => ({ before: edge.before, after: edge.after })),
    workflow: {
      kind: plan.kind,
      schemaVersion: plan.schemaVersion,
      taskIds: plan.taskIds,
      waves: plan.waves,
      taskWaves: plan.taskWaves,
      tree: plan.tree,
      debug: plan.debug,
      mermaid: plan.mermaid,
      summary: plan.summary,
    },
  };
}

module.exports = {
  WORKFLOW_NODE_KINDS,
  WORKFLOW_SCHEMA_VERSION,
  WorkflowValidationError,
  compileWorkflow,
  computeDependencyWaves,
  createTaskResolver,
  dedupeEdges,
  exportMermaid,
  hasWorkflowInput,
  normalizeDependencyEdges,
  parseWorkflowNode,
  taskIdsFromTasks,
  validateDependencyGraph,
  workflowManifestPatch,
};
