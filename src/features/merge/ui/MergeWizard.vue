<script setup lang="ts">
import { computed } from "vue";
import { gateSpecs, getSpec } from "@/features/catalog";
import { freePorts } from "../lib/boundary";
import type { useMerge } from "../model/useMerge";
import type { OutputRow, UpstreamRow } from "../lib/types";

const props = defineProps<{ merge: ReturnType<typeof useMerge> }>();
const {
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
  toggleNode,
  setAllNodes,
  onRowsChanged,
  runSearch,
  abortSearch,
  confirm,
  cancel,
} = props.merge;

const benchNodes = computed(() => props.merge.bench.value.nodes);
const benchInputs = computed(() =>
  benchNodes.value.filter((node) => node.kind === "INPUT"),
);
const benchLabel = (id: string) =>
  benchNodes.value.find((node) => node.id === id)?.label ?? "?";

const eqError = computed(() =>
  eqPreview.value && "error" in eqPreview.value ? eqPreview.value.error : null,
);

function onInputMode(row: { mode: string; bindId: string | null }) {
  if (row.mode === "bind" && !row.bindId)
    row.bindId = benchInputs.value[0]?.id ?? null;
  onRowsChanged();
}

function onUpstreamMode(row: UpstreamRow) {
  if (row.mode === "bind") {
    const candidates = candidatesOf(row.extId);
    if (!row.bindId || !candidates.includes(row.bindId))
      row.bindId = candidates[0] ?? null;
  }
  onRowsChanged();
}

function onOutputMode(row: OutputRow) {
  if (row.mode === "drive") {
    const target = benchNodes.value.find(
      (node) => freePorts(props.merge.bench.value, node.id).length > 0,
    );
    row.targetNode = target?.id ?? null;
    row.targetPort = target ? freePorts(props.merge.bench.value, target.id)[0] : null;
  }
}

function onDriveNode(row: OutputRow) {
  const ports = row.targetNode
    ? freePorts(props.merge.bench.value, row.targetNode)
    : [];
  row.targetPort = ports[0] ?? null;
}

function clampCosts() {
  for (const spec of gateSpecs) {
    const value = Number(costs.value[spec.kind]);
    costs.value[spec.kind] = Number.isFinite(value)
      ? Math.min(99, Math.max(0, Math.round(value)))
      : 1;
  }
}

const kindName = (kind: string) => getSpec(kind).name;
</script>

<template>
  <div class="merge-overlay" @pointerdown.self="cancel">
    <section class="merge-wizard" aria-label="并入外部实验">
      <header class="merge-header">
        <div>
          <h2>并入外部实验</h2>
          <p>
            来自 <b>{{ ext?.name }}</b> · 当前工作台保持不变，确认后才并入
          </p>
        </div>
        <button class="merge-close" aria-label="取消并入" @click="cancel">✕</button>
      </header>

      <div class="merge-body">
        <section class="merge-section">
          <h3>1 · 选区边界 <small>勾选要并入的外部元件（输入请在下方对应）</small></h3>
          <div class="merge-select-all">
            <button @click="setAllNodes(true)">全选</button>
            <button @click="setAllNodes(false)">清空</button>
            <span>已选 {{ selection.size }} / {{ extNodes.length }}</span>
          </div>
          <ul class="merge-check-list">
            <li v-for="node in extNodes" :key="node.id">
              <label>
                <input
                  type="checkbox"
                  :checked="selection.has(node.id)"
                  @change="
                    toggleNode(node.id, ($event.target as HTMLInputElement).checked)
                  "
                />
                <b>{{ node.label }}</b>
                <small>{{ node.kind }}</small>
              </label>
            </li>
          </ul>
        </section>

        <section class="merge-section" v-if="inputRows.length">
          <h3>2 · 输入对应 <small>外部输入信号从哪里来</small></h3>
          <table class="merge-table">
            <thead>
              <tr><th>外部输入</th><th>对应方式</th><th>工作台目标</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in inputRows" :key="row.extId">
                <td><b>{{ row.label }}</b></td>
                <td>
                  <select
                    v-model="row.mode"
                    @change="onInputMode(row)"
                    aria-label="输入对应方式"
                  >
                    <option value="auto">自动（按名称对应，否则引入）</option>
                    <option value="bind">绑定到现有输入</option>
                    <option value="import">引入为新输入</option>
                    <option value="float">明确保留悬空（X）</option>
                  </select>
                </td>
                <td>
                  <select
                    v-if="row.mode === 'bind'"
                    v-model="row.bindId"
                    aria-label="绑定到工作台输入"
                  >
                    <option v-for="node in benchInputs" :key="node.id" :value="node.id">
                      {{ node.label }}
                    </option>
                  </select>
                  <small v-else-if="row.mode === 'float'">下游针脚保持未知 X</small>
                  <small v-else>—</small>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="merge-section" v-if="upstreamRows.length">
          <h3>
            3 · 未选入的上游依赖
            <small>引入、绑定等价网络或明确悬空；锁定后搜索不得调整</small>
          </h3>
          <table class="merge-table">
            <thead>
              <tr>
                <th>外部网络</th><th>处理方式</th><th>等价候选</th><th>锁定</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in upstreamRows" :key="row.extId">
                <td><b>{{ row.label }}</b> <small>{{ row.kind }}</small></td>
                <td>
                  <select
                    v-model="row.mode"
                    @change="onUpstreamMode(row)"
                    aria-label="上游处理方式"
                  >
                    <option value="auto">自动（优先绑定等价网络）</option>
                    <option value="bind">绑定到现有等价网络</option>
                    <option value="import">继续引入其网络</option>
                    <option value="float">明确保留悬空（X）</option>
                  </select>
                </td>
                <td>
                  <template v-if="row.mode === 'bind'">
                    <select
                      v-model="row.bindId"
                      aria-label="绑定到等价网络"
                      :disabled="!candidatesOf(row.extId).length"
                    >
                      <option
                        v-for="id in candidatesOf(row.extId)"
                        :key="id"
                        :value="id"
                      >
                        {{ benchLabel(id) }}
                      </option>
                    </select>
                    <small v-if="!candidatesOf(row.extId).length" class="warn">
                      无等价网络，请改为引入或悬空
                    </small>
                  </template>
                  <small v-else>等价候选 {{ candidatesOf(row.extId).length }} 个</small>
                </td>
                <td>
                  <input
                    type="checkbox"
                    v-model="row.locked"
                    :disabled="row.mode === 'auto'"
                    aria-label="锁定该选择"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="merge-section" v-if="outputRows.length">
          <h3>4 · 选区输出接线 <small>选区结果送到哪里</small></h3>
          <table class="merge-table">
            <thead>
              <tr><th>选区信号</th><th>接法</th><th>目标</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in outputRows" :key="row.extId">
                <td><b>{{ row.label }}</b></td>
                <td>
                  <select
                    v-model="row.mode"
                    @change="onOutputMode(row)"
                    aria-label="输出接法"
                  >
                    <option value="none">仅引出，不接到工作台</option>
                    <option value="lamp">新增输出灯观察</option>
                    <option value="drive">接到现有元件的空输入端口</option>
                  </select>
                </td>
                <td>
                  <template v-if="row.mode === 'drive'">
                    <select v-model="row.targetNode" @change="onDriveNode(row)">
                      <option
                        v-for="node in benchNodes.filter(
                          (n) => freePorts(merge.bench.value, n.id).length > 0,
                        )"
                        :key="node.id"
                        :value="node.id"
                      >
                        {{ node.label }}
                      </option>
                    </select>
                    <select v-model="row.targetPort" v-if="row.targetNode">
                      <option
                        v-for="port in freePorts(merge.bench.value, row.targetNode)"
                        :key="port"
                        :value="port"
                      >
                        端口 {{ port + 1 }}
                      </option>
                    </select>
                  </template>
                  <small v-else>—</small>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="merge-section">
          <h3>5 · 门成本 <small>搜索以新增成本最低为先，其次接线变更最少</small></h3>
          <div class="merge-costs">
            <label v-for="spec in gateSpecs" :key="spec.kind">
              {{ spec.name }}
              <input
                type="number"
                min="0"
                max="99"
                v-model.number="costs[spec.kind]"
                @change="clampCosts"
              />
            </label>
          </div>
        </section>

        <p v-if="configError" class="merge-error">{{ configError }}</p>
        <p v-else-if="eqError" class="merge-error">{{ eqError }}</p>

        <div class="merge-actions">
          <button
            class="primary"
            :disabled="!!configError || !!eqError || searching"
            @click="runSearch"
          >
            {{ searching ? `搜索中…已展开 ${expansions} 个状态` : "寻找最优合并" }}
          </button>
          <button v-if="searching" @click="abortSearch">中止搜索</button>
          <button @click="cancel">取消</button>
        </div>

        <section class="merge-section" v-if="searched && !searching">
          <p v-if="searchError" class="merge-error">{{ searchError }}</p>
          <p v-else-if="!plans.length" class="merge-error">
            {{ complete ? "没有找到满足条件的合法合并。" : "搜索已中止，尚未找到合法合并。" }}
          </p>
          <template v-else-if="plan">
            <h3>
              6 · 合并预览
              <small :class="complete ? 'ok' : 'warn'">
                {{ complete ? "已达当前成本下最优" : "搜索未完整，以下方案未必最优" }}
                · 已逐点校验
              </small>
            </h3>
            <div class="merge-plan-nav" v-if="plans.length > 1">
              <button :disabled="planIndex <= 0" @click="planIndex--">← 上一方案</button>
              <span>同等最优方案 {{ planIndex + 1 }} / {{ plans.length }}</span>
              <button
                :disabled="planIndex >= plans.length - 1"
                @click="planIndex++"
              >
                下一方案 →
              </button>
            </div>
            <p class="merge-plan-summary">
              新增成本 <b>{{ plan.cost }}</b> · 外部接线变更
              <b>{{ plan.boundaryWires }}</b> 处 · 新增 {{ plan.newNodes.length }} 个元件
            </p>
            <div class="merge-preview-grid">
              <div>
                <h4>新增门</h4>
                <ul v-if="plan.newGates.length">
                  <li v-for="gate in plan.newGates" :key="gate.label">
                    {{ kindName(gate.kind) }} · {{ gate.label }}
                    <small>成本 {{ gate.cost }}</small>
                  </li>
                </ul>
                <p v-else><small>无需新增门，全部复用现有网络</small></p>
                <h4>接线变更</h4>
                <ul v-if="plan.boundaryWireDescs.length">
                  <li v-for="desc in plan.boundaryWireDescs" :key="desc">
                    {{ desc }}
                  </li>
                </ul>
                <p v-else><small>不改动任何现有接线</small></p>
              </div>
              <div>
                <h4>共用线路（复用现有网络）</h4>
                <ul v-if="plan.reusePairs.length || plan.sharePairs.length">
                  <li v-for="pair in plan.reusePairs" :key="pair.extId">
                    外部 {{ pair.extLabel }} ⇄ 工作台 {{ pair.benchLabel }}
                  </li>
                  <li v-for="pair in plan.sharePairs" :key="pair.extId">
                    外部 {{ pair.extLabel }} 与 {{ pair.withLabel }} 共用新增门
                  </li>
                </ul>
                <p v-else><small>没有可复用的现有网络</small></p>
                <h4>现有目标变化</h4>
                <template v-if="previewImpact">
                  <p>
                    目标「{{ previewImpact.targetTitle }}」：{{ previewImpact.before }}
                    → {{ previewImpact.after }}
                  </p>
                  <p v-if="previewImpact.affectedLabels.length">
                    受输出接线影响的现有支路：{{
                      previewImpact.affectedLabels.join("、")
                    }}
                  </p>
                  <p v-else><small>现有支路行为不变（已逐点校验）</small></p>
                </template>
              </div>
            </div>
            <p v-if="stale" class="merge-error">
              工作台在预览期间发生变化，正在重新核对候选…
            </p>
            <div class="merge-actions">
              <button class="primary" :disabled="stale" @click="confirm">
                确认并入工作台
              </button>
              <button @click="cancel">取消</button>
              <small class="merge-note">
                确认后合并结果即为真实电路拓扑，可正常保存、导出，不依赖外部文件。
              </small>
            </div>
          </template>
        </section>
      </div>
    </section>
  </div>
</template>
