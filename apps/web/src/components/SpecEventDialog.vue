<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { createIdempotencyKey } from "@/lib/idempotency";
import type { Material } from "@/types";

const props = defineProps<{
  modelValue: boolean;
  mode: "SPLIT" | "MERGE";
  material: Material;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  completed: [];
}>();

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit("update:modelValue", value)
});

const saving = ref(false);
const reason = ref("");

// 拆分：目标材料行，每行要么选择已有材料，要么填写新材料名称。
type SplitTargetRow = {
  mode: "existing" | "new";
  materialId: string;
  version: number | null;
  name: string;
  stockUnit: string;
};
const targets = ref<SplitTargetRow[]>([]);
type TransferRow = { batchId: string; quantity: string; unit: string; targetIndex: number | null };
const transfers = ref<TransferRow[]>([]);
const materialOptions = ref<Material[]>([]);

// 合并：来源材料行（目标固定为当前材料）。
type MergeSourceRow = { materialId: string; version: number | null };
const mergeSources = ref<MergeSourceRow[]>([]);

watch(visible, async (open) => {
  if (!open) return;
  reason.value = "";
  if (props.mode === "SPLIT") {
    targets.value = [{ mode: "new", materialId: "", version: null, name: "", stockUnit: props.material.stockUnit }];
    transfers.value = (props as any).material.batches
      ?.filter((batch: any) => batch.status !== "ARCHIVED")
      .map((batch: any) => ({ batchId: batch.id, quantity: batch.remainingQuantity, unit: batch.stockUnit, targetIndex: 0 })) ?? [];
  } else {
    mergeSources.value = [{ materialId: "", version: null }];
  }
  if (materialOptions.value.length === 0) {
    try {
      const response = await request<{ data: Material[] }>("/materials?pageSize=100");
      materialOptions.value = response.data.filter((item) => item.id !== props.material.id);
    } catch (error) {
      ElMessage.error(error instanceof ApiError ? error.message : "材料列表加载失败");
    }
  }
});

function addTarget() {
  targets.value.push({ mode: "new", materialId: "", version: null, name: "", stockUnit: props.material.stockUnit });
}
function removeTarget(index: number) {
  targets.value.splice(index, 1);
  for (const transfer of transfers.value) {
    if (transfer.targetIndex === index) transfer.targetIndex = null;
    else if (transfer.targetIndex !== null && transfer.targetIndex > index) transfer.targetIndex -= 1;
  }
}
function addMergeSource() {
  mergeSources.value.push({ materialId: "", version: null });
}
function removeMergeSource(index: number) {
  mergeSources.value.splice(index, 1);
}
function selectedMergeSourceIds(exclude?: number) {
  return new Set(mergeSources.value.map((row, index) => (index === exclude ? "" : row.materialId)).filter(Boolean));
}
function selectedTargetIds(exclude?: number) {
  return new Set(targets.value.map((row, index) => (index === exclude ? "" : row.materialId)).filter(Boolean));
}

function versionOf(materialId: string): number | null {
  return materialOptions.value.find((item) => item.id === materialId)?.version ?? null;
}

async function submitSplit() {
  if (reason.value.trim().length < 3) {
    ElMessage.error("请填写至少 3 个字的拆分原因");
    return;
  }
  const payloadTargets = targets.value.map((row) => {
    if (row.mode === "existing") {
      const version = row.version ?? versionOf(row.materialId);
      return { materialId: row.materialId, version: version ?? 1 };
    }
    return { material: { name: row.name.trim(), craftTypes: props.material.craftTypes, stockUnit: row.stockUnit || props.material.stockUnit } };
  });
  if (payloadTargets.some((target: any) => target.material && !target.material.name)) {
    ElMessage.error("请补全新建目标材料的名称");
    return;
  }
  const payloadTransfers = transfers.value
    .filter((row) => row.quantity && Number(row.quantity) > 0 && row.targetIndex !== null)
    .map((row) => ({
      sourceBatchId: row.batchId,
      targetMaterialOrdinal: row.targetIndex as number,
      quantity: row.quantity,
      unit: row.unit
    }));
  if (payloadTransfers.length === 0) {
    ElMessage.error("请至少填写一条有效的批次转出记录");
    return;
  }
  saving.value = true;
  try {
    await request(`/materials/${props.material.id}/split`, {
      method: "POST",
      headers: { "Idempotency-Key": createIdempotencyKey() },
      body: { version: props.material.version, reason: reason.value.trim(), targets: payloadTargets, transfers: payloadTransfers }
    });
    ElMessage.success("规格拆分已完成，来源材料按结余情况自动归档");
    visible.value = false;
    emit("completed");
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "规格拆分失败");
  } finally {
    saving.value = false;
  }
}

async function submitMerge() {
  if (reason.value.trim().length < 3) {
    ElMessage.error("请填写至少 3 个字的合并原因");
    return;
  }
  const sources = mergeSources.value
    .filter((row) => row.materialId)
    .map((row) => ({ materialId: row.materialId, version: row.version ?? versionOf(row.materialId) ?? 1 }));
  if (sources.length === 0) {
    ElMessage.error("请至少选择一个来源材料");
    return;
  }
  saving.value = true;
  try {
    await request("/materials/merge", {
      method: "POST",
      headers: { "Idempotency-Key": createIdempotencyKey() },
      body: {
        targetMaterialId: props.material.id,
        version: props.material.version,
        reason: reason.value.trim(),
        sources
      }
    });
    ElMessage.success("规格合并已完成，来源材料已归档");
    visible.value = false;
    emit("completed");
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "规格合并失败");
  } finally {
    saving.value = false;
  }
}

function submit() {
  if (props.mode === "SPLIT") return void submitSplit();
  return void submitMerge();
}

const title = computed(() => (props.mode === "SPLIT" ? "规格拆分" : "规格合并到本材料"));
</script>

<template>
  <el-dialog v-model="visible" :title="title" width="760px">
    <el-alert
      :title="mode === 'SPLIT'
        ? '拆分会把选中批次的库存转到目标材料并建立新批次；原批次记规格转出流水、历史不删除。全部转出后来源材料自动归档。'
        : '合并会把来源材料的全部在库批次整批转入本材料，按单位族自动换算；来源材料转出后自动归档，旧批次仍可追溯原档案。'"
      type="info" show-icon :closable="false" style="margin-bottom: 16px"
    />
    <el-form label-position="top">
      <el-form-item label="操作原因（至少 3 个字）" required>
        <el-input v-model="reason" maxlength="500" placeholder="例如：供应商更换粒度规格，档案需要拆分" />
      </el-form-item>

      <template v-if="mode === 'SPLIT'">
        <el-divider content-position="left">目标材料</el-divider>
        <div v-for="(target, index) in targets" :key="index" style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
          <el-radio-group v-model="target.mode" size="small">
            <el-radio-button value="new">新建</el-radio-button>
            <el-radio-button value="existing">已有</el-radio-button>
          </el-radio-group>
          <el-input v-if="target.mode === 'new'" v-model="target.name" placeholder="新目标材料名称" maxlength="120" />
          <el-select v-else v-model="target.materialId" filterable placeholder="选择已有材料" style="flex:1"
            @change="(id: string) => (target.version = versionOf(id))">
            <el-option v-for="option in materialOptions.filter((o) => !selectedTargetIds(index).has(o.id))"
              :key="option.id" :value="option.id"
              :label="`${option.name}（${option.stockUnit}）${option.archivedAt ? ' · 已归档' : ''}`"
              :disabled="Boolean(option.archivedAt)" />
          </el-select>
          <el-select v-if="target.mode === 'new'" v-model="target.stockUnit" style="width: 92px">
            <el-option v-for="unit in ['g','kg','ml','l','mm','cm','m','m2','pcs']" :key="unit" :value="unit" :label="unit" />
          </el-select>
          <el-button link type="danger" :disabled="targets.length === 1" @click="removeTarget(index)">删除</el-button>
        </div>
        <el-button size="small" @click="addTarget">增加目标材料</el-button>

        <el-divider content-position="left">批次转出</el-divider>
        <el-table :data="transfers" size="small">
          <el-table-column label="批次">
            <template #default="{ row }">{{ (material as any).batches?.find((b: any) => b.id === row.batchId)?.batchCode || row.batchId.slice(0, 8) }}</template>
          </el-table-column>
          <el-table-column label="转出数量" width="170">
            <template #default="{ row }"><el-input v-model="row.quantity" placeholder="0" /></template>
          </el-table-column>
          <el-table-column label="单位" width="90">
            <template #default="{ row }"><el-select v-model="row.unit"><el-option v-for="unit in ['g','kg','ml','l','mm','cm','m','m2','pcs']" :key="unit" :value="unit" :label="unit" /></el-select></template>
          </el-table-column>
          <el-table-column label="转入目标">
            <template #default="{ row }">
              <el-select v-model="row.targetIndex" placeholder="选择目标">
                <el-option v-for="(target, tIndex) in targets" :key="tIndex" :value="tIndex"
                  :label="target.mode === 'new' ? (target.name || `新目标 ${tIndex + 1}`) : (materialOptions.find((o) => o.id === target.materialId)?.name ?? target.materialId)" />
              </el-select>
            </template>
          </el-table-column>
        </el-table>
      </template>

      <template v-else>
        <el-divider content-position="left">来源材料（全部在库批次整批转入「{{ material.name }}」）</el-divider>
        <div v-for="(source, index) in mergeSources" :key="index" style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
          <el-select v-model="source.materialId" filterable placeholder="选择要并入的来源材料" style="flex:1"
            @change="(id: string) => (source.version = versionOf(id))">
            <el-option v-for="option in materialOptions.filter((o) => !selectedMergeSourceIds(index).has(o.id))"
              :key="option.id" :value="option.id"
              :label="`${option.name}（${option.stockUnit}）${option.archivedAt ? ' · 已归档' : ''}`"
              :disabled="Boolean(option.archivedAt)" />
          </el-select>
          <el-button link type="danger" :disabled="mergeSources.length === 1" @click="removeMergeSource(index)">删除</el-button>
        </div>
        <el-button size="small" @click="addMergeSource">增加来源材料</el-button>
      </template>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">确认{{ mode === "SPLIT" ? "拆分" : "合并" }}</el-button>
    </template>
  </el-dialog>
</template>
