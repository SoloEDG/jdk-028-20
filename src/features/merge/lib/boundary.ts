import type { CircuitDocument } from "@/shared/types";
import { getSpec } from "@/features/catalog";
import type { InputRow, OutputRow, UpstreamRow } from "./types";

interface NodeMaps {
  byId: Map<string, CircuitDocument["nodes"][number]>;
  /** nodeId -> 直接父节点 id 列表（按连线） */
  parents: Map<string, string[]>;
  /** nodeId -> 直接子节点 id 列表 */
  children: Map<string, string[]>;
}

export function buildMaps(document: CircuitDocument): NodeMaps {
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const parents = new Map(document.nodes.map((node) => [node.id, [] as string[]]));
  const children = new Map(document.nodes.map((node) => [node.id, [] as string[]]));
  for (const wire of document.wires) {
    if (!byId.has(wire.from.nodeId) || !byId.has(wire.to.nodeId)) continue;
    parents.get(wire.to.nodeId)!.push(wire.from.nodeId);
    children.get(wire.from.nodeId)!.push(wire.to.nodeId);
  }
  return { byId, parents, children };
}

/** 从若干起点沿上游收集全部 INPUT 节点 id。floated 中的节点不向下追溯。 */
function collectInputs(
  maps: NodeMaps,
  roots: Iterable<string>,
  floated: ReadonlySet<string>,
): Map<string, string> {
  const found = new Map<string, string>();
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = maps.byId.get(id);
    if (!node) continue;
    if (node.kind === "INPUT") {
      found.set(id, node.label);
      continue;
    }
    if (floated.has(id)) continue;
    for (const parent of maps.parents.get(id) ?? []) stack.push(parent);
  }
  return found;
}

/** 选区的直接未选上游（非 INPUT），即上游依赖边界。 */
function collectUpstream(
  maps: NodeMaps,
  selection: ReadonlySet<string>,
): Map<string, { label: string; kind: string }> {
  const found = new Map<string, { label: string; kind: string }>();
  for (const id of selection) {
    for (const parent of maps.parents.get(id) ?? []) {
      if (selection.has(parent)) continue;
      const node = maps.byId.get(parent);
      if (!node || node.kind === "INPUT") continue;
      found.set(parent, { label: node.label, kind: node.kind });
    }
  }
  return found;
}

/** 选区输出边界：选区内非 OUTPUT 节点中，有连线流向选区外、或在选区内没有消费者的节点。 */
function collectOutputs(
  maps: NodeMaps,
  selection: ReadonlySet<string>,
): Map<string, string> {
  const found = new Map<string, string>();
  for (const id of selection) {
    const node = maps.byId.get(id);
    if (!node || node.kind === "OUTPUT") continue;
    const kids = (maps.children.get(id) ?? []).filter((child) =>
      maps.byId.has(child),
    );
    const leaks = kids.some((child) => !selection.has(child));
    const consumed = kids.some((child) => selection.has(child));
    if (leaks || !consumed) found.set(id, node.label);
  }
  return found;
}

export interface Boundary {
  inputRows: InputRow[];
  upstreamRows: UpstreamRow[];
  outputRows: OutputRow[];
}

/**
 * 根据选区和各行的悬空选择计算边界行。
 * 已有行的选择按 extId 保留；被悬空切断的输入行自动消失。
 */
export function computeBoundary(
  ext: CircuitDocument,
  selection: ReadonlySet<string>,
  previous: {
    inputRows: InputRow[];
    upstreamRows: UpstreamRow[];
    outputRows: OutputRow[];
  },
): Boundary {
  const maps = buildMaps(ext);
  const floated = new Set<string>([
    ...previous.inputRows.filter((row) => row.mode === "float").map((row) => row.extId),
    ...previous.upstreamRows.filter((row) => row.mode === "float").map((row) => row.extId),
  ]);
  const oldInputs = new Map(previous.inputRows.map((row) => [row.extId, row]));
  const oldUps = new Map(previous.upstreamRows.map((row) => [row.extId, row]));
  const oldOuts = new Map(previous.outputRows.map((row) => [row.extId, row]));

  const inputRows: InputRow[] = [...collectInputs(maps, selection, floated)]
    .sort((a, b) => a[1].localeCompare(b[1], "zh-Hans-CN"))
    .map(([extId, label]) => {
      const old = oldInputs.get(extId);
      return old ? { ...old, label } : { extId, label, mode: "auto", bindId: null };
    });

  const upstreamRows: UpstreamRow[] = [...collectUpstream(maps, selection)]
    .sort((a, b) => a[1].label.localeCompare(b[1].label, "zh-Hans-CN"))
    .map(([extId, info]) => {
      const old = oldUps.get(extId);
      return old
        ? { ...old, label: info.label, kind: info.kind as UpstreamRow["kind"] }
        : {
            extId,
            label: info.label,
            kind: info.kind as UpstreamRow["kind"],
            mode: "auto",
            bindId: null,
            locked: false,
          };
    });

  const outputRows: OutputRow[] = [...collectOutputs(maps, selection)]
    .sort((a, b) => a[1].localeCompare(b[1], "zh-Hans-CN"))
    .map(([extId, label]) => {
      const old = oldOuts.get(extId);
      if (old) return { ...old, label };
      // 选区末端默认加输出灯便于观察；中途引出的默认仅引出
      const terminal = !(maps.children.get(extId) ?? []).some(
        (child) => selection.has(child),
      );
      const leaks = (maps.children.get(extId) ?? []).some(
        (child) => maps.byId.has(child) && !selection.has(child),
      );
      return {
        extId,
        label,
        mode: terminal && !leaks ? "lamp" : "none",
        targetNode: null,
        targetPort: null,
      };
    });

  return { inputRows, upstreamRows, outputRows };
}

/** 工作台中可用于绑定的 INPUT 节点。 */
export function benchInputs(bench: CircuitDocument) {
  return bench.nodes.filter((node) => node.kind === "INPUT");
}

/** 工作台中某节点输入端口是否空闲。 */
export function freePorts(
  bench: CircuitDocument,
  nodeId: string,
): number[] {
  const node = bench.nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  const used = new Set(
    bench.wires.filter((w) => w.to.nodeId === nodeId).map((w) => w.to.port),
  );
  const ports: number[] = [];
  for (let port = 0; port < getSpec(node.kind).inputs; port++)
    if (!used.has(port)) ports.push(port);
  return ports;
}

/** 收集从给定节点出发、沿下游可达的全部节点（含自身），用于"受影响支路"分析。 */
export function downstreamOf(
  bench: CircuitDocument,
  roots: Iterable<string>,
): Set<string> {
  const maps = buildMaps(bench);
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !maps.byId.has(id)) continue;
    seen.add(id);
    for (const child of maps.children.get(id) ?? []) stack.push(child);
  }
  return seen;
}

/** 收集某节点上游支撑中的 INPUT 节点 id。 */
export function inputSupport(bench: CircuitDocument, root: string): Set<string> {
  const maps = buildMaps(bench);
  const seen = new Set<string>();
  const support = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = maps.byId.get(id);
    if (!node) continue;
    if (node.kind === "INPUT") support.add(id);
    for (const parent of maps.parents.get(id) ?? []) stack.push(parent);
  }
  return support;
}
