import type { CircuitDocument, GateKind } from "@/shared/types";

/** 外部 INPUT 边界行：把外部实验的输入对应到工作台。 */
export interface InputRow {
  extId: string;
  label: string;
  /** auto = 按名称对应到现有输入，对应不到则引入新输入 */
  mode: "auto" | "bind" | "import" | "float";
  /** mode 为 bind 时，工作台侧被选中的元件 id */
  bindId: string | null;
}

/** 未被选入的非 INPUT 上游依赖行。 */
export interface UpstreamRow {
  extId: string;
  label: string;
  kind: GateKind;
  /** auto = 交给搜索决定（绑定等价网络或引入） */
  mode: "auto" | "bind" | "import" | "float";
  bindId: string | null;
  /** 锁定的选择搜索不得调整；未锁定的具体选择只是偏好 */
  locked: boolean;
}

/** 选区输出边界行：选区内部信号如何接到工作台。 */
export interface OutputRow {
  extId: string;
  label: string;
  /** none = 仅引出不接线；lamp = 新增输出灯；drive = 接到现有元件的空输入端口 */
  mode: "none" | "lamp" | "drive";
  targetNode: string | null;
  targetPort: number | null;
}

export type GateCosts = Record<GateKind, number>;

export interface MergeConfig {
  selection: Set<string>;
  inputRows: InputRow[];
  upstreamRows: UpstreamRow[];
  outputRows: OutputRow[];
  costs: GateCosts;
}

/** 搜索得到的单个合法合并方案。 */
export interface MergeSolution {
  /** 新增门成本（主目标，越低越好） */
  cost: number;
  /** 外部接线变更数：新增且碰到现有元件的连线（次目标） */
  boundaryWires: number;
  /** 外部节点 -> 实现方式：复用现有 / 共享新增门 / 引入新门 */
  decisions: Record<
    string,
    { reuse: string } | { share: string } | { import: true }
  >;
  /** 需要新建的外部输入（extId 列表） */
  freshInputs: string[];
  /** 需要新增输出灯的选区输出（extId 列表） */
  lamps: string[];
  /** 新增连线的日志，端点引用见 WireEnd */
  wires: SolutionWire[];
}

export type WireEnd =
  | { space: "bench"; id: string }
  | { space: "ext"; id: string }
  | { space: "fresh"; id: string }
  | { space: "lamp"; id: string };

export interface SolutionWire {
  from: WireEnd;
  to: WireEnd;
  /** to 端的输入端口序号 */
  pin: number;
}

/** 物化后的合并计划：只含新增内容，不引用外部文件。 */
export interface MergePlan {
  newNodes: Array<{
    key: string;
    id: string;
    kind: GateKind;
    label: string;
    x: number;
    y: number;
    value: 0 | 1;
  }>;
  newWires: Array<{
    id: string;
    from: { nodeId: string; port: number };
    to: { nodeId: string; port: number };
  }>;
  /** 外部节点复用现有工作台网络的对照 */
  reusePairs: Array<{
    extId: string;
    extLabel: string;
    benchId: string;
    benchLabel: string;
  }>;
  /** 外部节点之间共享同一个新增门的对照 */
  sharePairs: Array<{ extId: string; extLabel: string; withLabel: string }>;
  /** 行为会被输出接线改变的现有元件 id（含下游传播） */
  affectedBench: string[];
  cost: number;
  boundaryWires: number;
  /** 是否已通过全组合端到端校验 */
  verified: boolean;
  /** 展示用：新增门清单 */
  newGates: Array<{ kind: GateKind; label: string; cost: number }>;
  /** 展示用：碰到现有元件的新增连线 */
  boundaryWireDescs: string[];
}

export interface SearchOutcome {
  solutions: MergeSolution[];
  /** false 表示搜索被中止或超出预算，结果未必最优 */
  complete: boolean;
  expansions: number;
}

export interface MergeContext {
  bench: CircuitDocument;
  ext: CircuitDocument;
  config: MergeConfig;
}
