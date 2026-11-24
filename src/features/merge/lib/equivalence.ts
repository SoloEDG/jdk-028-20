import type { CircuitDocument, Signal } from "@/shared/types";
import { getSpec } from "@/features/catalog";
import { topologicalOrder } from "@/features/circuit";
import { evaluate, gateValue } from "@/features/simulation";
import { buildMaps, inputSupport } from "./boundary";
import type { InputRow, UpstreamRow } from "./types";

/** 等价核对允许的最大变量数（工作台侧支撑输入 + 新引入输入），超出则拒绝以免误判。 */
export const MAX_EQ_VARS = 10;

export type InputResolution =
  | { type: "bind"; benchId: string }
  | { type: "import" }
  | { type: "float" };

export interface ResolvedInputs {
  /** extId -> 对应方式（auto 已按名称展开） */
  resolutions: Map<string, InputResolution>;
  rows: InputRow[];
}

/** 展开输入行：auto = 唯一同名工作台输入则绑定，否则引入新输入。 */
export function resolveInputRows(
  bench: CircuitDocument,
  rows: InputRow[],
): ResolvedInputs {
  const resolutions = new Map<string, InputResolution>();
  for (const row of rows) {
    let resolution: InputResolution;
    if (row.mode === "float") resolution = { type: "float" };
    else if (row.mode === "import") resolution = { type: "import" };
    else if (row.mode === "bind" && row.bindId)
      resolution = { type: "bind", benchId: row.bindId };
    else {
      // auto（或 bind 但未选目标）：唯一同名工作台输入则绑定，否则引入新输入
      const matches = bench.nodes.filter(
        (node) => node.kind === "INPUT" && node.label === row.label,
      );
      resolution =
        matches.length === 1
          ? { type: "bind", benchId: matches[0].id }
          : { type: "import" };
    }
    resolutions.set(row.extId, resolution);
  }
  return { resolutions, rows };
}

/**
 * 评估外部实验：inputVals 覆盖 INPUT 节点的取值（可为 X），
 * floated 中的节点其出线被忽略（下游针脚保持 X）。
 */
export function evalExternal(
  ext: CircuitDocument,
  order: string[],
  inputVals: ReadonlyMap<string, Signal>,
  floated: ReadonlySet<string>,
): Map<string, Signal> {
  const byId = new Map(ext.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, typeof ext.wires>();
  for (const node of ext.nodes) incoming.set(node.id, []);
  for (const wire of ext.wires) incoming.get(wire.to.nodeId)?.push(wire);
  const values = new Map<string, Signal>();
  for (const id of order) {
    const node = byId.get(id)!;
    if (node.kind === "INPUT") {
      values.set(id, inputVals.get(id) ?? node.value);
      continue;
    }
    const pins: Signal[] = Array.from(
      { length: getSpec(node.kind).inputs },
      () => "X",
    );
    for (const wire of incoming.get(id)!) {
      if (floated.has(wire.from.nodeId)) continue;
      pins[wire.to.port] = values.get(wire.from.nodeId) ?? "X";
    }
    values.set(id, gateValue(node.kind, pins));
  }
  return values;
}

export interface Equivalence {
  /** 决策节点集合：选区 ∪（未被悬空切断的、非 INPUT 的传递上游） */
  decisionIds: string[];
  /** 外部节点 -> 功能等价的工作台节点 id 列表（已排除受影响支路） */
  benchCandidates: Map<string, string[]>;
  /** 外部节点 -> 真值表签名（用于新增门之间的共享） */
  extSigs: Map<string, string>;
  /** 工作台节点 -> 真值表签名 */
  benchSigs: Map<string, string>;
  /** 工作台侧支撑变量（INPUT id，有序） */
  benchVars: string[];
  /** 新引入输入对应的外部 INPUT id（有序） */
  freshVars: string[];
  /** 悬空节点集合 */
  floated: Set<string>;
  /** 输入行展开结果 */
  inputs: ResolvedInputs;
  /** 外部图的拓扑序 */
  extOrder: string[];
  rows: number;
}

/**
 * 计算功能等价关系：对边界变量的全部取值组合逐点比较三值信号。
 * 不看编号、名称或局部形状；悬空针脚按 X 参与比较，保持未知语义。
 */
export function buildEquivalence(
  bench: CircuitDocument,
  ext: CircuitDocument,
  selection: ReadonlySet<string>,
  inputRows: InputRow[],
  upstreamRows: UpstreamRow[],
  affectedBench: ReadonlySet<string>,
): Equivalence | { error: string } {
  const inputs = resolveInputRows(bench, inputRows);
  const floated = new Set<string>([
    ...inputRows.filter((row) => row.mode === "float").map((row) => row.extId),
    ...upstreamRows.filter((row) => row.mode === "float").map((row) => row.extId),
  ]);

  // 决策节点：选区加上传递上游（不穿过悬空点、不含 INPUT）
  const maps = buildMaps(ext);
  const decision = new Set<string>();
  const stack = [...selection];
  while (stack.length) {
    const id = stack.pop()!;
    if (decision.has(id)) continue;
    const node = maps.byId.get(id);
    if (!node || node.kind === "INPUT" || floated.has(id)) continue;
    decision.add(id);
    for (const parent of maps.parents.get(id) ?? []) stack.push(parent);
  }

  // 形式变量：绑定输入的工作台支撑 + 新引入输入
  const benchVarSet = new Set<string>();
  const freshVars: string[] = [];
  for (const row of inputRows) {
    const resolution = inputs.resolutions.get(row.extId)!;
    if (resolution.type === "bind")
      for (const id of inputSupport(bench, resolution.benchId))
        benchVarSet.add(id);
    else if (resolution.type === "import") freshVars.push(row.extId);
  }
  const benchVars = [...benchVarSet].sort();
  if (benchVars.length + freshVars.length > MAX_EQ_VARS)
    return {
      error: `边界变量共 ${benchVars.length + freshVars.length} 个，超过 ${MAX_EQ_VARS} 个上限；请把部分输入改为绑定或悬空`,
    };

  const extOrder = topologicalOrder(ext);
  const rowCount = 2 ** (benchVars.length + freshVars.length);
  const extSigs = new Map<string, string>();
  const benchSigs = new Map<string, string>();
  for (const node of ext.nodes) extSigs.set(node.id, "");
  for (const node of bench.nodes) benchSigs.set(node.id, "");

  const freshIndex = new Map(freshVars.map((id, index) => [id, index]));
  for (let a = 0; a < 2 ** benchVars.length; a++) {
    const overrides: Record<string, 0 | 1> = {};
    benchVars.forEach((id, index) => {
      overrides[id] = ((a >> index) & 1) as 0 | 1;
    });
    const benchVals = evaluate(bench, overrides).values;
    for (let b = 0; b < 2 ** freshVars.length; b++) {
      const inputVals = new Map<string, Signal>();
      for (const row of inputRows) {
        const resolution = inputs.resolutions.get(row.extId)!;
        if (resolution.type === "bind")
          inputVals.set(row.extId, benchVals[resolution.benchId] ?? "X");
        else if (resolution.type === "import")
          inputVals.set(
            row.extId,
            ((b >> freshIndex.get(row.extId)!) & 1) as 0 | 1,
          );
      }
      const extVals = evalExternal(ext, extOrder, inputVals, floated);
      for (const [id, sig] of extSigs)
        extSigs.set(id, sig + String(extVals.get(id) ?? "X"));
      for (const [id, sig] of benchSigs)
        benchSigs.set(id, sig + String(benchVals[id] ?? "X"));
    }
  }

  const benchCandidates = new Map<string, string[]>();
  for (const id of decision) {
    const sig = extSigs.get(id)!;
    // 输出灯只能复用输出灯：复用普通门会让观察点消失
    const lamp = maps.byId.get(id)!.kind === "OUTPUT";
    const candidates: string[] = [];
    for (const node of bench.nodes) {
      if (affectedBench.has(node.id)) continue;
      if (lamp && node.kind !== "OUTPUT") continue;
      if (benchSigs.get(node.id) === sig) candidates.push(node.id);
    }
    benchCandidates.set(id, candidates);
  }

  return {
    decisionIds: topologicalOrder(ext).filter((id) => decision.has(id)),
    benchCandidates,
    extSigs,
    benchSigs,
    benchVars,
    freshVars,
    floated,
    inputs,
    extOrder,
    rows: rowCount,
  };
}
