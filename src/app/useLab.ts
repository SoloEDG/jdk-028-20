import { ref } from "vue";
import type { Notice } from "@/shared/commands";
import type { CircuitDocument, Point } from "@/shared/types";
import { usePlacement } from "@/features/catalog";
import { useCircuit } from "@/features/circuit";
import { useSimulation } from "@/features/simulation";
import { useChallenge } from "@/features/challenge";
import { decodeDocument, loadInitial, useWorkspace } from "@/features/workspace";
import { useMerge } from "@/features/merge";
export function useLab() {
  const initial = loadInitial(),
    document = ref(initial.document);
  const notice = ref<Notice>({
    tone: initial.warning ? "error" : "info",
    message: initial.warning ?? "示例已就绪。切换输入，观察信号如何到达输出。",
  });
  const notify = (next: Notice) => {
    notice.value = next;
  };
  const placement = usePlacement();
  const circuit = useCircuit(document, notify);
  const simulation = useSimulation(document),
    challenge = useChallenge(document);
  const workspace = useWorkspace(document, notify, () => {
    circuit.resetSelection();
    challenge.reset();
    placement.tool.value = null;
  });
  const merge = useMerge(document, notify);
  /** 已解析、等待用户选择"替换还是并入"的外部实验 */
  const pendingImport = ref<CircuitDocument | null>(null);
  function requestImport(text: string) {
    try {
      pendingImport.value = decodeDocument(text);
    } catch (error) {
      notify({
        tone: "error",
        message: `导入失败：${error instanceof Error ? error.message : "文件无法读取"}；当前实验已保留`,
      });
    }
  }
  function importReplace() {
    if (!pendingImport.value) return;
    workspace.replace(pendingImport.value);
    pendingImport.value = null;
    notify({ tone: "success", message: "导入成功，实验已恢复" });
  }
  function importMerge() {
    if (!pendingImport.value) return;
    merge.open(pendingImport.value);
    pendingImport.value = null;
  }
  function importDismiss() {
    pendingImport.value = null;
    notify({ tone: "info", message: "已取消导入，当前实验保持不变" });
  }
  function place(point: Point) {
    if (!placement.tool.value) return;
    if (document.value.nodes.length >= 120) {
      notify({
        tone: "error",
        message: "最多支持 120 个元件，请先删除不用的元件",
      });
      return;
    }
    const node = placement.createNode(
      document.value,
      placement.tool.value,
      point,
    );
    document.value.nodes.push(node);
    circuit.selected.value = node.id;
    placement.tool.value = null;
    notify({
      tone: "success",
      message: `已放置 ${node.label}，点击端口开始连线`,
    });
  }
  function move(id: string, point: Point) {
    const node = document.value.nodes.find((n) => n.id === id);
    if (node) {
      node.x = point.x;
      node.y = point.y;
    }
  }
  function cancel() {
    circuit.pending.value = null;
    placement.tool.value = null;
    notify({ tone: "info", message: "已取消当前放置或连线" });
  }
  function renameNode(label: string) {
    const node = document.value.nodes.find(
      (n) => n.id === circuit.selected.value,
    );
    if (node) node.label = label.trim().slice(0, 40) || node.kind;
  }
  return {
    document,
    notice,
    notify,
    placement,
    circuit,
    simulation,
    challenge,
    workspace,
    merge,
    pendingImport,
    requestImport,
    importReplace,
    importMerge,
    importDismiss,
    place,
    move,
    cancel,
    renameNode,
  };
}
