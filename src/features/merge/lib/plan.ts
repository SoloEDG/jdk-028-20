import type { CircuitDocument, GateKind } from "@/shared/types";
import { createId } from "@/shared/document";
import { topologicalOrder } from "@/features/circuit";
import { evaluate } from "@/features/simulation";
import { BOARD } from "@/features/circuit/lib/geometry";
import { buildMaps, downstreamOf } from "./boundary";
import { evalExternal, type Equivalence } from "./equivalence";
import { MERGE_LIMITS } from "./search";
import type {
  GateCosts,
  MergeConfig,
  MergePlan,
  MergeSolution,
  WireEnd,
} from "./types";

interface NewNodeSpec {
  key: string;
  kind: GateKind;
  baseLabel: string;
  anchor: { x: number; y: number };
  value: 0 | 1;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const snap = (value: number) => Math.round(value / 20) * 20;

/** 为新增节点找一块不压住现有元件的区域，保持外部实验的相对布局。 */
function layoutNewNodes(
  bench: CircuitDocument,
  specs: NewNodeSpec[],
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (!specs.length) return result;
  const minX = Math.min(...specs.map((s) => s.anchor.x));
  const minY = Math.min(...specs.map((s) => s.anchor.y));
  const width = Math.max(...specs.map((s) => s.anchor.x)) - minX + BOARD.nodeWidth;
  const height = Math.max(...specs.map((s) => s.anchor.y)) - minY + BOARD.nodeHeight;
  const origins: Array<{ x: number; y: number }> = [];
  if (bench.nodes.length) {
    const bottom = Math.max(...bench.nodes.map((n) => n.y)) + BOARD.nodeHeight + 40;
    const right = Math.max(...bench.nodes.map((n) => n.x)) + BOARD.nodeWidth + 40;
    origins.push({ x: 60, y: bottom }, { x: right, y: 60 });
  }
  origins.push({ x: 60, y: 60 }, { x: 400, y: 220 });

  const overlapsBench = (x: number, y: number) =>
    bench.nodes.some(
      (n) =>
        Math.abs(n.x - x) < BOARD.nodeWidth + 8 &&
        Math.abs(n.y - y) < BOARD.nodeHeight + 8,
    );
  for (const origin of origins) {
    if (origin.x + width > BOARD.width + 200 || origin.y + height > BOARD.height + 200)
      continue;
    const placed = specs.map((spec) => {
      const x = clamp(snap(origin.x + spec.anchor.x - minX), 24, 864);
      const y = clamp(snap(origin.y + spec.anchor.y - minY), 48, 412);
      return { key: spec.key, x, y };
    });
    if (placed.every((p) => !overlapsBench(p.x, p.y))) {
      for (const p of placed) result.set(p.key, { x: p.x, y: p.y });
      return result;
    }
  }
  // 区域不够就接受最后候选，允许用户稍后拖动
  const origin = origins[origins.length - 1];
  for (const spec of specs)
    result.set(spec.key, {
      x: clamp(snap(origin.x + spec.anchor.x - minX), 24, 864),
      y: clamp(snap(origin.y + spec.anchor.y - minY), 48, 412),
    });
  return result;
}

function dedupeLabels(
  bench: CircuitDocument,
  specs: NewNodeSpec[],
): Map<string, string> {
  const used = new Set(bench.nodes.map((node) => node.label));
  const labels = new Map<string, string>();
  for (const spec of specs) {
    const base = spec.baseLabel.trim().slice(0, 36) || spec.kind;
    let label = base;
    for (let n = 2; used.has(label); n++) label = `${base}·${n}`.slice(0, 40);
    used.add(label);
    labels.set(spec.key, label);
  }
  return labels;
}

/**
 * 把搜索方案物化为合并计划：全新 id、去重名称、落位坐标。
 * 计划只含普通节点与连线，不保留任何对外部文件的引用。
 */
export function materializePlan(
  bench: CircuitDocument,
  ext: CircuitDocument,
  config: MergeConfig,
  eq: Equivalence,
  solution: MergeSolution,
): MergePlan | { error: string } {
  const extMaps = buildMaps(ext);
  const specs: NewNodeSpec[] = [];
  const idOf = new Map<string, string>(); // WireEnd key -> 新节点 id

  for (const [extId, decision] of Object.entries(solution.decisions)) {
    if (!("import" in decision)) continue;
    const node = extMaps.byId.get(extId)!;
    specs.push({
      key: `E:${extId}`,
      kind: node.kind,
      baseLabel: node.label,
      anchor: { x: node.x, y: node.y },
      value: 0,
    });
  }
  for (const extId of solution.freshInputs) {
    const node = extMaps.byId.get(extId)!;
    specs.push({
      key: `F:${extId}`,
      kind: "INPUT",
      baseLabel: node.label,
      anchor: { x: node.x, y: node.y },
      value: node.value,
    });
  }
  for (const extId of solution.lamps) {
    const node = extMaps.byId.get(extId)!;
    specs.push({
      key: `L:${extId}`,
      kind: "OUTPUT",
      baseLabel: `${node.label} 输出`,
      anchor: { x: node.x + 160, y: node.y },
      value: 0,
    });
  }

  const positions = layoutNewNodes(bench, specs);
  const labels = dedupeLabels(bench, specs);
  const newNodes: MergePlan["newNodes"] = specs.map((spec) => {
    const id = createId("node");
    idOf.set(spec.key, id);
    const position = positions.get(spec.key)!;
    return {
      key: spec.key,
      id,
      kind: spec.kind,
      label: labels.get(spec.key)!,
      x: position.x,
      y: position.y,
      value: spec.value,
    };
  });

  const resolve = (end: WireEnd): string =>
    end.space === "bench" ? end.id : idOf.get(keyOfEnd(end))!;
  const keyOfEnd = (end: WireEnd): string =>
    end.space === "ext"
      ? `E:${end.id}`
      : end.space === "fresh"
        ? `F:${end.id}`
        : end.space === "lamp"
          ? `L:${end.id}`
          : `B:${end.id}`;

  const newWires: MergePlan["newWires"] = solution.wires.map((wire) => ({
    id: createId("wire"),
    from: { nodeId: resolve(wire.from), port: 0 },
    to: { nodeId: resolve(wire.to), port: wire.pin },
  }));
  if (newWires.some((w) => !w.from.nodeId || !w.to.nodeId))
    return { error: "合并方案内部引用失效" };

  const nodeLabel = (id: string) =>
    bench.nodes.find((n) => n.id === id)?.label ??
    newNodes.find((n) => n.id === id)?.label ??
    "?";
  const extLabel = (id: string) => extMaps.byId.get(id)?.label ?? "?";

  const reusePairs: MergePlan["reusePairs"] = [];
  const sharePairs: MergePlan["sharePairs"] = [];
  for (const [extId, decision] of Object.entries(solution.decisions)) {
    if ("reuse" in decision)
      reusePairs.push({
        extId,
        extLabel: extLabel(extId),
        benchId: decision.reuse,
        benchLabel: nodeLabel(decision.reuse),
      });
    else if ("share" in decision)
      sharePairs.push({
        extId,
        extLabel: extLabel(extId),
        withLabel: extLabel(decision.share),
      });
  }

  const costs: GateCosts = config.costs;
  const newGates = newNodes.map((node) => ({
    kind: node.kind,
    label: node.label,
    cost: costs[node.kind],
  }));
  const boundaryWireDescs = solution.wires
    .filter((wire) => wire.from.space === "bench" || wire.to.space === "bench")
    .map((wire) => {
      const from =
        wire.from.space === "bench"
          ? nodeLabel(wire.from.id)
          : labels.get(keyOfEnd(wire.from))!;
      const to =
        wire.to.space === "bench"
          ? `${nodeLabel(wire.to.id)} 端口${wire.pin + 1}`
          : `${labels.get(keyOfEnd(wire.to))!} 端口${wire.pin + 1}`;
      return `${from} → ${to}`;
    });

  const driveTargets = config.outputRows
    .filter((row) => row.mode === "drive" && row.targetNode)
    .map((row) => row.targetNode!);
  const affectedBench = [...downstreamOf(bench, driveTargets)];

  const plan: MergePlan = {
    newNodes,
    newWires,
    reusePairs,
    sharePairs,
    affectedBench,
    cost: solution.cost,
    boundaryWires: solution.boundaryWires,
    verified: false,
    newGates,
    boundaryWireDescs,
  };

  const check = verifyPlan(bench, ext, config, eq, solution, plan);
  if (check) return { error: check };
  plan.verified = true;
  return plan;
}

/**
 * 端到端校验：对边界变量的全部取值组合，确认
 * 1) 选区信号在合并后的电路中与外部实验逐点一致（含 X 语义）；
 * 2) 未受输出接线影响的现有支路行为完全不变。
 */
function verifyPlan(
  bench: CircuitDocument,
  ext: CircuitDocument,
  config: MergeConfig,
  eq: Equivalence,
  solution: MergeSolution,
  plan: MergePlan,
): string | null {
  const merged: CircuitDocument = {
    version: 1,
    name: bench.name,
    targetId: bench.targetId,
    nodes: [...bench.nodes, ...plan.newNodes.map((n) => ({ ...n }))],
    wires: [
      ...bench.wires,
      ...plan.newWires.map((w) => ({
        id: w.id,
        from: { ...w.from },
        to: { ...w.to },
      })),
    ],
  };
  if (
    merged.nodes.length > MERGE_LIMITS.nodes ||
    merged.wires.length > MERGE_LIMITS.wires
  )
    return "合并后超出工作台容量（120 元件 / 480 连线）";
  try {
    topologicalOrder(merged);
  } catch {
    return "合并方案会形成反馈环";
  }

  const keyToId = new Map(plan.newNodes.map((node) => [node.key, node.id]));
  const freshIds = new Map<string, string>();
  for (const extId of solution.freshInputs) {
    const id = keyToId.get(`F:${extId}`);
    if (!id) return "合并方案内部引用失效";
    freshIds.set(extId, id);
  }

  const realizedId = new Map<string, string>();
  for (const [extId, decision] of Object.entries(solution.decisions)) {
    if ("reuse" in decision) realizedId.set(extId, decision.reuse);
    else if ("share" in decision) {
      const target = realizedId.get(decision.share);
      if (!target) return "合并方案内部引用失效";
      realizedId.set(extId, target);
    } else {
      const id = keyToId.get(`E:${extId}`);
      if (!id) return "合并方案内部引用失效";
      realizedId.set(extId, id);
    }
  }

  const affected = new Set(plan.affectedBench);
  const untouched = bench.nodes.filter((node) => !affected.has(node.id));
  const freshList = [...freshIds.entries()];
  const rows = 2 ** (eq.benchVars.length + eq.freshVars.length);

  for (let row = 0; row < rows; row++) {
    const overrides: Record<string, 0 | 1> = {};
    eq.benchVars.forEach((id, index) => {
      overrides[id] = ((row >> index) & 1) as 0 | 1;
    });
    freshList.forEach((entry, index) => {
      overrides[entry[1]] = ((row >> (eq.benchVars.length + index)) & 1) as 0 | 1;
    });
    const mergedVals = evaluate(merged, overrides).values;
    const benchVals = evaluate(bench, overrides).values;
    const inputVals = new Map<string, 0 | 1 | "X">();
    for (const inputRow of config.inputRows) {
      const resolution = eq.inputs.resolutions.get(inputRow.extId)!;
      if (resolution.type === "bind")
        inputVals.set(inputRow.extId, benchVals[resolution.benchId] ?? "X");
      else if (resolution.type === "import") {
        const nodeId = freshIds.get(inputRow.extId);
        if (nodeId) inputVals.set(inputRow.extId, overrides[nodeId]);
      }
    }
    const extVals = evalExternal(ext, eq.extOrder, inputVals, eq.floated);
    for (const id of config.selection) {
      const realized = realizedId.get(id);
      if (!realized) return "选区节点未被实现";
      if (mergedVals[realized] !== extVals.get(id))
        return "合并校验失败：选区信号与外部实验不一致";
    }
    for (const node of untouched)
      if (mergedVals[node.id] !== benchVals[node.id])
        return "合并校验失败：现有支路行为被改变";
  }
  return null;
}
