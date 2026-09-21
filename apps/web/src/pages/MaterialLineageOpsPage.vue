<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { craftTypeLabels, type Material, type ApiMeta } from "@/types";

type BatchRow = {
  id: string;
  batchCode: string | null;
  remainingQuantity: string;
  stockUnit: string;
  status: string;
  receivedAt: string;
};

const UNITS = ["g", "kg", "ml", "l", "mm", "cm", "m", "m2", "pcs"];

// 单位族：与 contracts/unitFamilies 保持一致，用于前端即时提示
const UNIT_FAMILY: Record<string, string> = {
  g: "MASS", kg: "MASS", ml: "VOLUME", l: "VOLUME",
  mm: "LENGTH", cm: "LENGTH", m: "LENGTH", m2: "AREA", pcs: "COUNT"
};

const route = useRoute();
const router = useRouter();
const activeTab = ref<"split" | "merge">(route.query.mode === "merge" ? "merge" : "split");
const loading = ref(true);
const material = ref<(Material & { batches: BatchRow[] }) | null>(null);
const mergeCandidates = ref<Material[]>([]);
const saving = ref(false);

const splitForm = reactive({
  reason: "",
  name: "",
  code: "",
  craftTypes: [] as string[],
  subtype: "",
  stockUnit: "g",
  lowStockThreshold: "",
  defaultColorName: "",
  defaultColorHex: "",
  tagsText: "",
  notes: "",
  batchIds: [] as string[],
  archiveSourceWhenEmpty: true
});

const mergeForm = reactive({
  reason: "",
  targetMaterialId: "",
  archiveSourceWhenEmpty: true
});

const selectableBatches = computed(() => material.value?.batches.filter((b) => b.status !== "ARCHIVED") ?? []);
const sourceUnit = computed(() => material.value?.stockUnit ?? "");
const splitUnitCompatible = computed(() => !sourceUnit.value || UNIT_FAMILY[sourceUnit.value] === UNIT_FAMILY[splitForm.stockUnit]);
const splitCrossUnit = computed(() => sourceUnit.value !== splitForm.stockUnit);
const splitBatchWarning = computed(() => {
  if (!splitCrossUnit.value) return "";
  const zero = selectableBatches.value.find(
    (b) => splitForm.batchIds.includes(b.id) && Number(b.remainingQuantity) === 0
  );
  return zero ? "跨单位拆分不能包含零余额批次，请取消勾选该批次。" : "";
});

const targetMaterial = computed(() => mergeCandidates.value.find((m) => m.id === mergeForm.targetMaterialId) ?? null);
const mergeUnitCompatible = computed(() =>
  !targetMaterial.value || !material.value ||
  UNIT_FAMILY[targetMaterial.value.stockUnit] === UNIT_FAMILY[material.value.stockUnit]
);
const mergeHasBatches = computed(() => selectableBatches.value.length > 0);

function materialLabel(m: Material): string {
  return `${m.name}（${m.stockUnit}）${m.code ? ` · ${m.code}` : ""}`;
}

async function load() {
  loading.value = true;
  try {
    const detailPromise = request<{ data: Material & { batches: BatchRow[] } }>(`/materials/${route.params.id}`);
    // 分页拉全量未归档材料作为合并候选，避免材料超过单页上限时漏掉目标
    const firstPage = await request<{ data: Material[]; meta: ApiMeta }>("/materials?page=1&pageSize=100");
    const pages = [firstPage];
    for (let page = 2; page <= firstPage.meta.totalPages; page++) {
      pages.push(await request<{ data: Material[]; meta: ApiMeta }>(`/materials?page=${page}&pageSize=100`));
    }
    const detail = await detailPromise;
    material.value = detail.data;
    splitForm.stockUnit = detail.data.stockUnit;
    splitForm.craftTypes = [...detail.data.craftTypes];
    mergeCandidates.value = pages.flatMap((p) => p.data).filter(
      (m) => m.id !== detail.data.id && !m.archivedAt && m.stockUnit !== detail.data.stockUnit
    );
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "材料加载失败");
  } finally {
    loading.value = false;
  }
}

async function submitSplit() {
  if (!material.value) return;
  if (!splitForm.reason.trim() || splitForm.reason.trim().length < 3) {
    ElMessage.error("请填写至少 3 个字的变更原因，用于审计追溯");
    return;
  }
  if (!splitForm.name.trim() || splitForm.craftTypes.length === 0) {
    ElMessage.error("请填写新规格材料名称并至少选择一种工艺");
    return;
  }
  if (!splitUnitCompatible.value) {
    ElMessage.error("新规格单位必须与来源单位属于同一单位族（如 g ↔ kg）");
    return;
  }
  if (splitForm.batchIds.length === 0) {
    ElMessage.error("请至少选择一个要拆出的批次");
    return;
  }
  if (splitBatchWarning.value) {
    ElMessage.error(splitBatchWarning.value);
    return;
  }
  saving.value = true;
  try {
    const response = await request<{ data: { eventId: string; targetMaterial: { id: string }; sourceArchived: boolean } }>(
      `/materials/${material.value.id}/split`,
      {
        method: "POST",
        body: {
          version: material.value.version,
          reason: splitForm.reason.trim(),
          archiveSourceWhenEmpty: splitForm.archiveSourceWhenEmpty,
          batchIds: splitForm.batchIds,
          newMaterial: {
            name: splitForm.name.trim(),
            code: splitForm.code || null,
            craftTypes: splitForm.craftTypes,
            subtype: splitForm.subtype || null,
            stockUnit: splitForm.stockUnit,
            lowStockThreshold: splitForm.lowStockThreshold || null,
            defaultColorName: splitForm.defaultColorName || null,
            defaultColorHex: splitForm.defaultColorHex || null,
            tags: splitForm.tagsText.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
            notes: splitForm.notes || null
          }
        }
      }
    );
    ElMessage.success(response.data.sourceArchived ? "拆分完成，来源材料已归档" : "拆分完成");
    await router.push(`/materials/${response.data.targetMaterial.id}`);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "拆分失败");
  } finally {
    saving.value = false;
  }
}

async function submitMerge() {
  if (!material.value) return;
  if (!mergeForm.targetMaterialId) {
    ElMessage.error("请选择合并目标材料");
    return;
  }
  if (!mergeUnitCompatible.value) {
    ElMessage.error("目标规格单位必须与来源单位属于同一单位族");
    return;
  }
  if (!mergeHasBatches.value) {
    ElMessage.error("当前材料没有可合并的非归档批次");
    return;
  }
  if (!mergeForm.reason.trim() || mergeForm.reason.trim().length < 3) {
    ElMessage.error("请填写至少 3 个字的合并原因，用于审计追溯");
    return;
  }
  const target = targetMaterial.value!;
  saving.value = true;
  try {
    const response = await request<{ data: { eventId: string; targetMaterialId: string; archivedSources: string[] } }>(
      "/materials/merge",
      {
        method: "POST",
        body: {
          version: material.value.version,
          targetVersion: target.version,
          reason: mergeForm.reason.trim(),
          sourceMaterialIds: [material.value.id],
          targetMaterialId: target.id,
          archiveSourceWhenEmpty: mergeForm.archiveSourceWhenEmpty
        }
      }
    );
    ElMessage.success(response.data.archivedSources.includes(material.value.id) ? "合并完成，来源材料已归档" : "合并完成");
    await router.push(`/materials/${target.id}`);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "合并失败");
  } finally {
    saving.value = false;
  }
}

function onSelectionChange(rows: BatchRow[]) {
  splitForm.batchIds = rows.map((r) => r.id);
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <header class="page-header">
      <div>
        <h1>规格拆分与合并</h1>
        <p v-if="material">{{ material.name }}（{{ material.stockUnit }}）· 历史批次与单位换算会完整保留在谱系记录中</p>
      </div>
      <el-button @click="router.back()">返回</el-button>
    </header>

    <el-alert
      v-if="material?.archivedAt"
      type="error"
      :closable="false"
      title="该材料已归档，不能再执行拆分或合并"
      style="margin-bottom: 16px"
    />

    <el-tabs v-else v-model="activeTab" class="panel">
      <!-- 拆分 -->
      <el-tab-pane label="拆分为新规格" name="split">
        <el-form label-position="top" style="max-width: 720px">
          <el-form-item label="变更原因（必填，写入审计与谱系）">
            <el-input v-model="splitForm.reason" type="textarea" :rows="2" maxlength="1000" show-word-limit
              placeholder="例如：苏木原先按 g 散装管理，新购入的线轴规格按 m 管理，需拆分为独立档案" />
          </el-form-item>

          <el-divider content-position="left">新规格材料档案</el-divider>
          <div class="form-grid">
            <el-form-item label="材料名称" required><el-input v-model="splitForm.name" maxlength="120" /></el-form-item>
            <el-form-item label="材料编码"><el-input v-model="splitForm.code" maxlength="64" /></el-form-item>
            <el-form-item label="适用工艺" required>
              <el-select v-model="splitForm.craftTypes" multiple style="width: 100%">
                <el-option v-for="(label, value) in craftTypeLabels" :key="value" :value="value" :label="label" />
              </el-select>
            </el-form-item>
            <el-form-item label="细分类型"><el-input v-model="splitForm.subtype" maxlength="80" /></el-form-item>
            <el-form-item label="新规格库存单位" required>
              <el-select v-model="splitForm.stockUnit" style="width: 100%">
                <el-option v-for="unit in UNITS" :key="unit" :value="unit" :label="unit" />
              </el-select>
            </el-form-item>
            <el-form-item label="低库存阈值"><el-input v-model="splitForm.lowStockThreshold" placeholder="留空表示不预警" /></el-form-item>
            <el-form-item label="默认颜色名称"><el-input v-model="splitForm.defaultColorName" maxlength="80" /></el-form-item>
            <el-form-item label="默认颜色值">
              <div style="display:flex; gap:10px; width:100%">
                <el-color-picker v-model="splitForm.defaultColorHex" />
                <el-input v-model="splitForm.defaultColorHex" placeholder="#RRGGBB" />
              </div>
            </el-form-item>
            <el-form-item label="标签" class="full"><el-input v-model="splitForm.tagsText" placeholder="用逗号分隔" /></el-form-item>
            <el-form-item label="备注" class="full">
              <el-input v-model="splitForm.notes" type="textarea" :rows="3" maxlength="5000" show-word-limit />
            </el-form-item>
          </div>
          <el-alert v-if="!splitUnitCompatible" type="error" :closable="false" show-icon
            :title="`单位 ${splitForm.stockUnit} 与来源单位 ${sourceUnit} 不属于同一单位族，无法换算`" style="margin-bottom:12px" />
          <el-alert v-else-if="splitCrossUnit" type="info" :closable="false" show-icon
            title="跨单位拆分：被选中批次将逐批按单位族换算后在新档案下开账，旧批次余额转出并归档，换算明细写入谱系。"
            style="margin-bottom:12px" />
          <el-alert v-else type="info" :closable="false" show-icon
            title="同单位拆分：被选中批次直接改挂到新档案，库存流水原样保留。" style="margin-bottom:12px" />

          <el-divider content-position="left">选择拆出的批次</el-divider>
          <el-table :data="selectableBatches" max-height="320" @selection-change="onSelectionChange">
            <el-table-column type="selection" width="48" />
            <el-table-column label="批次">
              <template #default="{ row }">{{ row.batchCode || "无批次号" }}</template>
            </el-table-column>
            <el-table-column label="剩余数量" width="160">
              <template #default="{ row }">{{ row.remainingQuantity }} {{ row.stockUnit }}</template>
            </el-table-column>
            <el-table-column label="入库日期" prop="receivedAt" width="130" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }"><el-tag size="small">{{ row.status === "ACTIVE" ? "有库存" : "已耗尽" }}</el-tag></template>
            </el-table-column>
          </el-table>

          <el-form-item style="margin-top: 16px">
            <el-checkbox v-model="splitForm.archiveSourceWhenEmpty">批次全部迁出后自动归档来源材料</el-checkbox>
          </el-form-item>
          <el-button type="primary" size="large" :loading="saving" @click="submitSplit">执行拆分</el-button>
        </el-form>
      </el-tab-pane>

      <!-- 合并 -->
      <el-tab-pane label="合并到其他规格" name="merge">
        <el-form label-position="top" style="max-width: 720px">
          <el-form-item label="合并原因（必填，写入审计与谱系）">
            <el-input v-model="mergeForm.reason" type="textarea" :rows="2" maxlength="1000" show-word-limit
              placeholder="例如：确认两种染材实为同一规格，统一合并到 kg 规格档案" />
          </el-form-item>
          <el-form-item label="目标材料（同单位族、未归档的其他规格）">
            <el-select v-model="mergeForm.targetMaterialId" filterable style="width: 100%" placeholder="选择目标规格材料">
              <el-option v-for="m in mergeCandidates" :key="m.id" :value="m.id" :label="materialLabel(m)" />
            </el-select>
          </el-form-item>
          <el-alert v-if="mergeForm.targetMaterialId && !mergeUnitCompatible" type="error" :closable="false" show-icon
            title="目标规格单位与当前材料不属于同一单位族，无法换算合并" style="margin-bottom:12px" />
          <el-alert v-else-if="targetMaterial" type="info" :closable="false" show-icon
            :title="`当前材料全部非归档批次将迁移到「${targetMaterial.name}」。同单位批次直接改挂；跨单位批次逐批换算后在目标档案开账，旧批次转出并归档，关联的项目需求数量同步换算。`"
            style="margin-bottom:12px" />
          <el-alert v-if="!mergeHasBatches" type="warning" :closable="false" show-icon
            title="当前材料没有非归档批次，无法合并" style="margin-bottom:12px" />
          <el-form-item>
            <el-checkbox v-model="mergeForm.archiveSourceWhenEmpty">批次全部迁走后自动归档当前材料</el-checkbox>
          </el-form-item>
          <el-button type="primary" size="large" :loading="saving" @click="submitMerge">执行合并</el-button>
        </el-form>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
