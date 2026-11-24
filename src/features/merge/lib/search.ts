import type { CircuitDocument, GateKind } from "@/shared/types";
import { getSpec } from "@/features/catalog";
import { buildMaps } from "./boundary";
import type { Equivalence } from "./equivalence";
import type {
  GateCosts,
  MergeConfig,
  MergeSolution,
  SearchOutcome,
  SolutionWire,
  UpstreamRow,
  WireEnd,
} from "./types";

/** 与 codec 的容量限制保持一致 */
export const MERGE_LIMITS = { nodes: 120, wires: 480 };
/** 搜索预算：展开状态数上限，超出则报告结果未必最优 */
export const MAX_EXPANSIONS = 150_000;
/** 同等最优方案最多保留几个供比较 */
export const MAX_SOLUTIONS = 8;

type Decision =
  | { kind: "reuse"; benchId: string }
  | { kind: "share"; extId: string }
  | { kind: "import" };

interface PendRec {
  to: WireEnd;
  pin: number;
}

type Op =
  | { op: "decide"; id: string }
  | { op: "require"; id: string }
  | { op: "fresh"; id: string; cost: number }
  | { op: "lamp"; id: string; cost: number }
  | { op: "node"; cost: number }
  | { op: "wire"; fromKey: string; boundary: boolean }
  | { op: "pending-add"; parent: string }
  | { op: "pending-take"; parent: string; recs: PendRec[] };

const keyOf = (end: WireEnd): string =>
  end.space === "bench"
    ? `B:${end.id}`
    : end.space === "ext"
      ? `E:${end.id}`
      : end.space === "fresh"
        ? `F:${end.id}`
        : `L:${end.id}`;

/** from 是否能沿已有连线到达 to（用于加边前的成环检查） */
function reaches(adj: ReadonlyMap<string, readonly string[]>, from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length) {
    for (const next of adj.get(stack.pop()!) ?? []) {
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

export async function searchMerges(
  bench: CircuitDocument,
  ext: CircuitDocument,
  config: MergeConfig,
  eq: Equivalence,
  control: { aborted: boolean },
  onProgress: (expansions: number) => void = () => {},
): Promise<SearchOutcome | { error: string }> {
  const costs: GateCosts = config.costs;
  const extMaps = buildMaps(ext);
  const upstreamByExt = new Map<string, UpstreamRow>(
    config.upstreamRows.map((row) => [row.extId, row]),
  );
  const outputByExt = new Map(config.outputRows.map((row) => [row.extId, row]));

  // 锁定的绑定必须先验证等价，不满足则直接判配置错误，绝不暗中调整
  for (const row of config.upstreamRows) {
    if (row.mode === "bind" && row.bindId) {
      const candidates = eq.benchCandidates.get(row.extId) ?? [];
      if (!candidates.includes(row.bindId)) {
        const node = bench.nodes.find((n) => n.id === row.bindId);
        return {
          error: `上游「${row.label}」绑定的「${node?.label ?? "?"}」与外部信号不等价，请重新对应`,
        };
      }
    }
  }
  // 输出接线端口必须仍然空闲，且两行不能占用同一端口
  const claimed = new Set<string>();
  for (const row of config.outputRows) {
    if (row.mode !== "drive" || !row.targetNode || row.targetPort === null)
      continue;
    const key = `${row.targetNode}:${row.targetPort}`;
    if (claimed.has(key)) return { error: "两个输出接线指向了同一端口" };
    claimed.add(key);
    const occupied = bench.wires.some(
      (w) => w.to.nodeId === row.targetNode && w.to.port === row.targetPort,
    );
    if (occupied) return { error: "输出接线的目标端口已被占用，请重新选择" };
  }

  // ---- 搜索状态 ----
  const decisions = new Map<string, Decision>();
  const required = new Set<string>(
    [...config.selection].filter((id) => eq.decisionIds.includes(id)),
  );
  const pending = new Map<string, PendRec[]>();
  const journal: SolutionWire[] = [];
  const adj = new Map<string, string[]>();
  const fresh = new Set<string>();
  const lamps = new Set<string>();
  const ops: Op[] = [];
  let cost = 0;
  let boundaryWires = 0;
  let newNodes = 0;
  let expansions = 0;
  let complete = true;

  for (const wire of bench.wires) {
    const from = `B:${wire.from.nodeId}`;
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from)!.push(`B:${wire.to.nodeId}`);
  }

  function undoTo(mark: number) {
    while (ops.length > mark) {
      const op = ops.pop()!;
      switch (op.op) {
        case "decide":
          decisions.delete(op.id);
          break;
        case "require":
          required.delete(op.id);
          break;
        case "fresh":
          fresh.delete(op.id);
          break;
        case "lamp":
          lamps.delete(op.id);
          break;
        case "node":
          newNodes--;
          cost -= op.cost;
          break;
        case "wire": {
          journal.pop();
          adj.get(op.fromKey)!.pop();
          if (op.boundary) boundaryWires--;
          break;
        }
        case "pending-add": {
          const list = pending.get(op.parent)!;
          list.pop();
          if (!list.length) pending.delete(op.parent);
          break;
        }
        case "pending-take":
          pending.set(op.parent, op.recs);
          break;
      }
    }
  }

  function addNode(kind: GateKind): boolean {
    if (bench.nodes.length + newNodes >= MERGE_LIMITS.nodes) return false;
    newNodes++;
    cost += costs[kind];
    ops.push({ op: "node", cost: costs[kind] });
    return true;
  }

  function addWire(from: WireEnd, to: WireEnd, pin: number): boolean {
    if (bench.wires.length + journal.length >= MERGE_LIMITS.wires) return false;
    const fromKey = keyOf(from);
    const toKey = keyOf(to);
    if (reaches(adj, toKey, fromKey)) return false; // 会形成反馈环
    journal.push({ from, to, pin });
    if (!adj.has(fromKey)) adj.set(fromKey, []);
    adj.get(fromKey)!.push(toKey);
    const boundary = from.space === "bench" || to.space === "bench";
    if (boundary) boundaryWires++;
    ops.push({ op: "wire", fromKey, boundary });
    return true;
  }

  function realizationOf(id: string): WireEnd | null {
    const decision = decisions.get(id);
    if (!decision) return null;
    if (decision.kind === "reuse") return { space: "bench", id: decision.benchId };
    if (decision.kind === "share") return { space: "ext", id: decision.extId };
    return { space: "ext", id };
  }

  /** 解析以 E 为父节点的待接连线，并处理 E 的输出边界行 */
  function settleOutgoing(id: string, source: WireEnd): boolean {
    const pend = pending.get(id);
    if (pend?.length) {
      ops.push({ op: "pending-take", parent: id, recs: pend });
      pending.delete(id);
      for (const rec of pend)
        if (!addWire(source, rec.to, rec.pin)) return false;
    }
    const row = outputByExt.get(id);
    if (row?.mode === "lamp") {
      if (!addNode("OUTPUT")) return false;
      lamps.add(id);
      ops.push({ op: "lamp", id, cost: costs.OUTPUT });
      if (!addWire(source, { space: "lamp", id }, 0)) return false;
    } else if (row?.mode === "drive" && row.targetNode && row.targetPort !== null) {
      if (
        !addWire(source, { space: "bench", id: row.targetNode }, row.targetPort)
      )
        return false;
    }
    return true;
  }

  function applyReuse(id: string, target: WireEnd): boolean {
    decisions.set(
      id,
      target.space === "bench"
        ? { kind: "reuse", benchId: target.id }
        : { kind: "share", extId: target.id },
    );
    ops.push({ op: "decide", id });
    return settleOutgoing(id, target);
  }

  function applyImport(id: string): boolean {
    const node = extMaps.byId.get(id)!;
    if (!addNode(node.kind)) return false;
    decisions.set(id, { kind: "import" });
    ops.push({ op: "decide", id });
    const self: WireEnd = { space: "ext", id };
    const spec = getSpec(node.kind);
    for (let pin = 0; pin < spec.inputs; pin++) {
      const wire = ext.wires.find(
        (w) => w.to.nodeId === id && w.to.port === pin,
      );
      if (!wire) continue; // 针脚本就悬空，保持 X 语义
      const parentId = wire.from.nodeId;
      if (eq.floated.has(parentId)) continue; // 用户明确保留悬空
      const parent = extMaps.byId.get(parentId)!;
      if (parent.kind === "INPUT") {
        const resolution = eq.inputs.resolutions.get(parentId);
        if (!resolution || resolution.type === "float") continue;
        if (resolution.type === "bind") {
          if (
            !addWire({ space: "bench", id: resolution.benchId }, self, pin)
          )
            return false;
        } else {
          if (!fresh.has(parentId)) {
            if (!addNode("INPUT")) return false;
            fresh.add(parentId);
            ops.push({ op: "fresh", id: parentId, cost: costs.INPUT });
          }
          if (!addWire({ space: "fresh", id: parentId }, self, pin))
            return false;
        }
      } else {
        const source = realizationOf(parentId);
        if (source) {
          if (!addWire(source, self, pin)) return false;
        } else {
          if (!pending.has(parentId)) pending.set(parentId, []);
          pending.get(parentId)!.push({ to: self, pin });
          ops.push({ op: "pending-add", parent: parentId });
          if (!required.has(parentId)) {
            required.add(parentId);
            ops.push({ op: "require", id: parentId });
          }
        }
      }
    }
    return settleOutgoing(id, self);
  }

  type Choice = { reuse: WireEnd } | { import: true };

  function choicesFor(id: string): Choice[] {
    const row = upstreamByExt.get(id);
    const reuseChoices: Choice[] = (eq.benchCandidates.get(id) ?? []).map(
      (benchId) => ({ reuse: { space: "bench", id: benchId } }),
    );
    // 已引入且功能相同的新增门也可以共享（不新增门）；
    // 输出灯只能与输出灯共享，否则观察点会消失
    const sig = eq.extSigs.get(id);
    const isLamp = extMaps.byId.get(id)!.kind === "OUTPUT";
    const shareChoices: Choice[] = [];
    for (const [otherId, decision] of decisions) {
      if (decision.kind !== "import") continue;
      if (isLamp && extMaps.byId.get(otherId)!.kind !== "OUTPUT") continue;
      if (eq.extSigs.get(otherId) === sig)
        shareChoices.push({ reuse: { space: "ext", id: otherId } });
    }
    const importChoice: Choice = { import: true };
    if (row?.locked) {
      // 锁定的选择不得调整：只保留用户指定的那一种
      if (row.mode === "bind" && row.bindId)
        return [{ reuse: { space: "bench", id: row.bindId } }];
      if (row.mode === "import") return [importChoice];
    }
    if (row && !row.locked && row.mode === "bind" && row.bindId) {
      // 未锁定的具体选择只是偏好：有效则排在最前，仍允许更优替代
      const preferred = row.bindId;
      const valid = (eq.benchCandidates.get(id) ?? []).includes(preferred);
      return [
        ...(valid ? [{ reuse: { space: "bench", id: preferred } } as Choice] : []),
        ...reuseChoices.filter(
          (choice) =>
            (choice as { reuse: WireEnd }).reuse.id !== preferred,
        ),
        ...shareChoices,
        importChoice,
      ];
    }
    if (row && !row.locked && row.mode === "import")
      return [importChoice, ...reuseChoices, ...shareChoices];
    return [...reuseChoices, ...shareChoices, importChoice];
  }

  // ---- 分支限界 DFS：按拓扑逆序（先消费者后提供者）处理决策节点 ----
  const order = [...eq.decisionIds].reverse();
  let best: { cost: number; wires: number } | null = null;
  const solutions: MergeSolution[] = [];

  function snapshot(): MergeSolution {
    const record: MergeSolution["decisions"] = {};
    for (const [id, decision] of decisions) {
      if (decision.kind === "reuse") record[id] = { reuse: decision.benchId };
      else if (decision.kind === "share") record[id] = { share: decision.extId };
      else record[id] = { import: true };
    }
    return {
      cost,
      boundaryWires,
      decisions: record,
      freshInputs: [...fresh],
      lamps: [...lamps],
      wires: journal.map((wire) => ({
        from: { ...wire.from },
        to: { ...wire.to },
        pin: wire.pin,
      })),
    };
  }

  function recordSolution() {
    const better =
      !best || cost < best.cost || (cost === best.cost && boundaryWires < best.wires);
    const equal =
      best && cost === best.cost && boundaryWires === best.wires;
    if (better) {
      best = { cost, wires: boundaryWires };
      solutions.length = 0;
      solutions.push(snapshot());
    } else if (equal && solutions.length < MAX_SOLUTIONS) {
      solutions.push(snapshot());
    }
  }

  async function dfs(index: number): Promise<void> {
    if (!complete) return;
    if (control.aborted || expansions >= MAX_EXPANSIONS) {
      complete = false;
      return;
    }
    if (index >= order.length) {
      // 不变量：所有待接连线都必须已解析，否则方案不完整
      if (pending.size === 0) recordSolution();
      return;
    }
    // 单调递增的两个目标都可用于剪枝
    if (
      best &&
      (cost > best.cost || (cost === best.cost && boundaryWires > best.wires))
    )
      return;
    expansions++;
    if (expansions % 512 === 0) {
      onProgress(expansions);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (control.aborted) {
        complete = false;
        return;
      }
    }
    const id = order[index];
    if (!required.has(id)) {
      await dfs(index + 1);
      return;
    }
    for (const choice of choicesFor(id)) {
      const mark = ops.length;
      const ok =
        "import" in choice
          ? applyImport(id)
          : applyReuse(id, choice.reuse);
      if (ok) await dfs(index + 1);
      undoTo(mark);
      if (!complete) return;
    }
  }

  await dfs(0);
  return { solutions, complete, expansions };
}
