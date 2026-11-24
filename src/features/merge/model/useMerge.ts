import { computed, ref, watch, type Ref } from "vue";
import type { CircuitDocument } from "@/shared/types";
import type { Notice } from "@/shared/commands";
import { topologicalOrder } from "@/features/circuit";
import { targetById, truthTable } from "@/features/challenge";
import { computeBoundary, downstreamOf } from "../lib/boundary";
import { buildEquivalence } from "../lib/equivalence";
import { searchMerges } from "../lib/search";
import { materializePlan } from "../lib/plan";
import type {
  GateCosts,
  InputRow,
  MergePlan,
  OutputRow,
  UpstreamRow,
} from "../lib/types";

const fingerprint = (document: CircuitDocument) =>
  JSON.stringify([document.nodes, document.wires]);

const defaultCosts = (): GateCosts => ({
  INPUT: 1,
  OUTPUT: 1,
  AND: 1,
  OR: 1,
  XOR: 1,
  NOT: 1,
  NAND: 1,
  NOR: 1,
});

export function useMerge(
  document: Ref<CircuitDocument>,
  notify: (notice: Notice) => void,
) {
  const active = ref(false);
  const ext = ref<CircuitDocument | null>(null);
  const selection = ref<Set<string>>(new Set());
  const inputRows = ref<InputRow[]>([]);
  const upstreamRows = ref<UpstreamRow[]>([]);
  const outputRows = ref<OutputRow[]>([]);
  const costs = ref<GateCosts>(defaultCosts());

  const searching = ref(false);
  const expansions = ref(0);
  const complete = ref(true);
  const plans = ref<MergePlan[]>([]);
  const planIndex = ref(0);
  const searchError = ref<string | null>(null);
  const searched = ref(false);
  const stale = ref(false);
  let fingerprintAtSearch = "";
  let control: { aborted: boolean } | null = null;
  let searchToken = 0;
  let recheckTimer: ReturnType<typeof setTimeout> | null = null;

  const extNodes = computed(() =>
    (ext.value?.nodes ?? []).filter((node) => node.kind !== "INPUT"),
  );

  const configError = computed<string | null>(() => {
    if (!ext.value) return "没有可并入的外部实验";
    if (!selection.value.size) return "请至少勾选一个要并入的外部元件";
    const benchIds = new Set(document.value.nodes.map((node) => node.id));
    for (const row of inputRows.value)
      if (row.mode === "bind" && (!row.bindId || !benchIds.has(row.bindId)))
        return `输入「${row.label}」的绑定目标已不存在，请重新对应`;
    for (const row of upstreamRows.value) {
      if (row.mode === "bind" && (!row.bindId || !benchIds.has(row.bindId)))
        return `上游「${row.label}」的绑定目标已不存在，请重新对应`;
    }
    const claimed = new Set<string>();
    for (const row of outputRows.value) {
      if (row.mode !== "drive") continue;
      if (!row.targetNode || row.targetPort === null || !benchIds.has(row.targetNode))
        return `输出「${row.label}」的接线目标已不存在，请重新选择`;
      const key = `${row.targetNode}:${row.targetPort}`;
      if (claimed.has(key)) return "两个输出接线指向了同一端口";
      claimed.add(key);
    }
    return null;
  });

  function rebuildBoundary() {
    if (!ext.value) return;
    const boundary = computeBoundary(ext.value, selection.value, {
      inputRows: inputRows.value,
      upstreamRows: upstreamRows.value,
      outputRows: outputRows.value,
    });
    inputRows.value = boundary.inputRows;
    upstreamRows.value = boundary.upstreamRows;
    outputRows.value = boundary.outputRows;
  }

  function open(external: CircuitDocument) {
    ext.value = external;
    selection.value = new Set(
      external.nodes.filter((node) => node.kind !== "INPUT").map((n) => n.id),
    );
    inputRows.value = [];
    upstreamRows.value = [];
    outputRows.value = [];
    costs.value = defaultCosts();
    rebuildBoundary();
    plans.value = [];
    planIndex.value = 0;
    searched.value = false;
    searchError.value = null;
    stale.value = false;
    complete.value = true;
    active.value = true;
  }

  function close() {
    if (control) control.aborted = true;
    if (recheckTimer) clearTimeout(recheckTimer);
    active.value = false;
    searching.value = false;
    searched.value = false;
    stale.value = false;
    ext.value = null;
    plans.value = [];
  }

  function toggleNode(id: string, on: boolean) {
    const next = new Set(selection.value);
    if (on) next.add(id);
    else next.delete(id);
    selection.value = next;
    rebuildBoundary();
  }

  function setAllNodes(on: boolean) {
    selection.value = on
      ? new Set(
          (ext.value?.nodes ?? [])
            .filter((node) => node.kind !== "INPUT")
            .map((node) => node.id),
        )
      : new Set();
    rebuildBoundary();
  }

  function onRowsChanged() {
    rebuildBoundary();
  }

  // 配置变化后，旧方案失效，需要重新搜索
  watch(
    [selection, inputRows, upstreamRows, outputRows, costs],
    () => {
      plans.value = [];
      searched.value = false;
      searchError.value = null;
    },
    { deep: true },
  );

  /** 等价关系预览：为绑定下拉列表和候选计数提供实时结果 */
  const eqPreview = computed(() => {
    const external = ext.value;
    if (!external || !selection.value.size) return null;
    const driveTargets = outputRows.value
      .filter((row) => row.mode === "drive" && row.targetNode)
      .map((row) => row.targetNode!);
    const affected = downstreamOf(document.value, driveTargets);
    return buildEquivalence(
      document.value,
      external,
      selection.value,
      inputRows.value,
      upstreamRows.value,
      affected,
    );
  });

  function candidatesOf(extId: string): string[] {
    const eq = eqPreview.value;
    if (!eq || "error" in eq) return [];
    return eq.benchCandidates.get(extId) ?? [];
  }

  async function runSearch() {
    if (!ext.value || configError.value || searching.value) return;
    const token = ++searchToken;
    searching.value = true;
    searchError.value = null;
    searched.value = false;
    expansions.value = 0;
    fingerprintAtSearch = fingerprint(document.value);
    stale.value = false;
    const bench = document.value;
    const external = ext.value;
    const config = {
      selection: new Set(selection.value),
      inputRows: inputRows.value.map((row) => ({ ...row })),
      upstreamRows: upstreamRows.value.map((row) => ({ ...row })),
      outputRows: outputRows.value.map((row) => ({ ...row })),
      costs: { ...costs.value },
    };
    try {
      const driveTargets = config.outputRows
        .filter((row) => row.mode === "drive" && row.targetNode)
        .map((row) => row.targetNode!);
      const affected = downstreamOf(bench, driveTargets);
      const eq = buildEquivalence(
        bench,
        external,
        config.selection,
        config.inputRows,
        config.upstreamRows,
        affected,
      );
      if ("error" in eq) {
        searchError.value = eq.error;
        searched.value = true;
        return;
      }
      control = { aborted: false };
      const outcome = await searchMerges(bench, external, config, eq, control, (n) => {
        expansions.value = n;
      });
      if (token !== searchToken) return; // 已有更新的搜索
      if ("error" in outcome) {
        searchError.value = outcome.error;
        searched.value = true;
        return;
      }
      const built: MergePlan[] = [];
      let firstError: string | null = null;
      for (const solution of outcome.solutions) {
        const plan = materializePlan(bench, external, config, eq, solution);
        if ("error" in plan) firstError ??= plan.error;
        else built.push(plan);
      }
      complete.value = outcome.complete;
      expansions.value = outcome.expansions;
      plans.value = built;
      planIndex.value = 0;
      searched.value = true;
      if (!built.length && firstError) searchError.value = firstError;
    } finally {
      searching.value = false;
    }
  }

  function abortSearch() {
    if (control) control.aborted = true;
  }

  // 预览期间工作台发生变化：作废旧方案并自动重新核对候选
  watch(
    document,
    () => {
      if (!active.value || searching.value || !searched.value) return;
      if (fingerprint(document.value) === fingerprintAtSearch) return;
      stale.value = true;
      if (recheckTimer) clearTimeout(recheckTimer);
      recheckTimer = setTimeout(() => {
        if (!active.value || !stale.value) return;
        notify({ tone: "info", message: "工作台已变化，正在重新核对候选方案" });
        runSearch();
      }, 400);
    },
    { deep: true },
  );

  const plan = computed<MergePlan | null>(
    () => plans.value[planIndex.value] ?? null,
  );

  /** 预览信息：现有目标（挑战检测与现有支路）在合并前后的变化 */
  const previewImpact = computed(() => {
    const current = plan.value;
    if (!current || !ext.value) return null;
    const target = targetById(document.value.targetId);
    const before = truthTable(document.value, target);
    const merged: CircuitDocument = {
      ...document.value,
      nodes: [...document.value.nodes, ...current.newNodes],
      wires: [...document.value.wires, ...current.newWires],
    };
    const after = truthTable(merged, target);
    const summarize = (table: typeof before) =>
      table.error
        ? `未检测（${table.error}）`
        : table.rows.every((row) => row.matches)
          ? "通过"
          : `${table.rows.filter((row) => row.matches).length}/${table.rows.length} 行匹配`;
    const affectedLabels = current.affectedBench
      .map(
        (id) => document.value.nodes.find((node) => node.id === id)?.label,
      )
      .filter((label): label is string => !!label);
    return {
      targetTitle: target.title,
      before: summarize(before),
      after: summarize(after),
      affectedLabels,
    };
  });

  function confirm(): boolean {
    const current = plan.value;
    if (!current || !current.verified || searching.value) return false;
    if (stale.value || fingerprint(document.value) !== fingerprintAtSearch) {
      // 预览期间电路变过且尚未完成重核，不能直接套用
      stale.value = true;
      notify({ tone: "info", message: "工作台已变化，正在重新核对候选方案" });
      runSearch();
      return false;
    }
    const merged: CircuitDocument = {
      ...document.value,
      nodes: [
        ...document.value.nodes,
        ...current.newNodes.map((node) => ({ ...node })),
      ],
      wires: [
        ...document.value.wires,
        ...current.newWires.map((wire) => ({
          id: wire.id,
          from: { ...wire.from },
          to: { ...wire.to },
        })),
      ],
    };
    try {
      topologicalOrder(merged);
    } catch {
      notify({ tone: "error", message: "合并会形成反馈环，已取消；当前实验已保留" });
      return false;
    }
    document.value.nodes = merged.nodes;
    document.value.wires = merged.wires;
    const reused = current.reusePairs.length;
    notify({
      tone: "success",
      message: `已并入 ${current.newNodes.length} 个新元件、${current.newWires.length} 条连线${reused ? `，复用 ${reused} 处现有网络` : ""}`,
    });
    close();
    return true;
  }

  function cancel() {
    close();
    notify({ tone: "info", message: "已取消并入，当前实验保持不变" });
  }

  return {
    active,
    bench: document,
    ext,
    extNodes,
    selection,
    inputRows,
    upstreamRows,
    outputRows,
    costs,
    searching,
    expansions,
    complete,
    plans,
    plan,
    planIndex,
    searchError,
    searched,
    stale,
    configError,
    previewImpact,
    eqPreview,
    candidatesOf,
    open,
    close,
    cancel,
    confirm,
    toggleNode,
    setAllNodes,
    onRowsChanged,
    runSearch,
    abortSearch,
  };
}
