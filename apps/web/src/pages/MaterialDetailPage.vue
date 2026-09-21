<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { craftTypeLabels, specEventLabels, statusLabels, type Material, type MaterialLineageEvent } from "@/types";
import SpecEventDialog from "@/components/SpecEventDialog.vue";

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const material = ref<(Material & { batches: any[] }) | null>(null);
const lineage = ref<MaterialLineageEvent[]>([]);
const dialogVisible = ref(false);
const dialogMode = ref<"SPLIT" | "MERGE">("SPLIT");

async function load() {
  loading.value = true;
  try {
    const [detail, lineageResponse] = await Promise.all([
      request<{ data: Material & { batches: any[] } }>(`/materials/${route.params.id}`),
      request<{ data: MaterialLineageEvent[] }>(`/materials/${route.params.id}/lineage`)
    ]);
    material.value = detail.data;
    lineage.value = lineageResponse.data;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "材料加载失败");
  } finally {
    loading.value = false;
  }
}

function openDialog(mode: "SPLIT" | "MERGE") {
  dialogMode.value = mode;
  dialogVisible.value = true;
}

async function archive() {
  if (!material.value) return;
  try {
    await ElMessageBox.confirm("归档后材料不会出现在新建记录中，但历史仍保留。仅在无正库存时允许归档。", "确认归档", { type: "warning" });
    await request(`/materials/${route.params.id}/archive`, { method: "POST", body: { version: material.value.version } });
    ElMessage.success("材料已归档");
    await router.push("/materials");
  } catch (error: any) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof ApiError ? error.message : "归档失败");
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <template v-if="material">
      <header class="page-header">
        <div><h1>{{ material.name }}</h1><p>{{ material.code || "无材料编码" }} · {{ material.subtype || "未分类" }}</p></div>
        <div>
          <el-button v-if="!material.archivedAt" @click="router.push(`/materials/${material.id}/edit`)">编辑</el-button>
          <el-button type="primary" @click="router.push({ path: '/batches/new', query: { materialId: material.id } })">新批次入库</el-button>
          <el-button v-if="!material.archivedAt" type="warning" plain @click="openDialog('SPLIT')">规格拆分</el-button>
          <el-button v-if="!material.archivedAt" type="success" plain @click="openDialog('MERGE')">规格合并</el-button>
          <el-button v-if="!material.archivedAt" type="danger" plain @click="archive">归档</el-button>
        </div>
      </header>
      <section class="stat-grid">
        <article class="stat-card"><small>当前聚合库存</small><strong>{{ material.remainingQuantity }} {{ material.stockUnit }}</strong></article>
        <article class="stat-card"><small>有效批次</small><strong>{{ material.batchCount }}</strong></article>
        <article class="stat-card"><small>低库存阈值</small><strong>{{ material.lowStockThreshold || "未设置" }}</strong></article>
      </section>
      <section class="panel" style="margin-top: 16px">
        <h2>材料档案</h2>
        <el-descriptions :column="3" border>
          <el-descriptions-item label="适用工艺"><el-tag v-for="type in material.craftTypes" :key="type" size="small" style="margin-right:4px">{{ craftTypeLabels[type] || type }}</el-tag></el-descriptions-item>
          <el-descriptions-item label="默认颜色"><span v-if="material.defaultColorHex" class="color-dot" :style="{ background: material.defaultColorHex }" />{{ material.defaultColorName || "未设置" }}</el-descriptions-item>
          <el-descriptions-item label="库存单位">{{ material.stockUnit }}</el-descriptions-item>
          <el-descriptions-item label="标签" :span="2">{{ material.tags?.join("、") || "无" }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ material.archivedAt ? "已归档" : "使用中" }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="3">{{ material.notes || "无" }}</el-descriptions-item>
        </el-descriptions>
      </section>
      <section class="panel">
        <h2>批次明细</h2>
        <el-table :data="material.batches">
          <el-table-column label="批次">
            <template #default="{ row }"><router-link :to="`/batches/${row.id}`">{{ row.batchCode || "无批次号" }}</router-link><div class="muted">{{ row.sourceName || "来源不明" }} · {{ row.locationName || "未指定位置" }}</div></template>
          </el-table-column>
          <el-table-column label="剩余/初始" width="180"><template #default="{ row }"><span class="amount">{{ row.remainingQuantity }} / {{ row.initialQuantity }} {{ row.stockUnit }}</span></template></el-table-column>
          <el-table-column label="当前颜色" width="140"><template #default="{ row }"><span v-if="row.currentColorHex" class="color-dot" :style="{ background: row.currentColorHex }" />{{ row.currentColorName || "未记录" }}</template></el-table-column>
          <el-table-column label="入库日期" prop="receivedAt" width="120" />
          <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag>{{ statusLabels[row.status] || row.status }}</el-tag></template></el-table-column>
        </el-table>
        <el-empty v-if="material.batches.length === 0" description="该材料还没有批次">
          <el-button type="primary" @click="router.push({ path: '/batches/new', query: { materialId: material.id } })">录入第一批材料</el-button>
        </el-empty>
      </section>

      <section class="panel">
        <h2>规格沿革</h2>
        <el-timeline v-if="lineage.length">
          <el-timeline-item v-for="event in lineage" :key="event.id" :timestamp="new Date(event.createdAt).toLocaleString()" placement="top">
            <el-tag size="small" :type="event.eventType === 'SPLIT' ? 'warning' : 'success'" style="margin-right: 8px">
              {{ specEventLabels[event.eventType] }}
            </el-tag>
            <strong>{{ event.reason }}</strong>
            <div class="muted" style="margin: 4px 0">
              <span v-for="participant in event.participants" :key="`${participant.role}-${participant.ordinal}`" style="margin-right: 12px">
                <el-tag size="small" :type="participant.role === 'SOURCE' ? 'info' : 'primary'" effect="plain">
                  {{ participant.role === "SOURCE" ? "来源" : "目标" }}
                </el-tag>
                {{ participant.nameSnapshot }}（{{ participant.stockUnitSnapshot }}）
              </span>
            </div>
            <div v-for="transfer in event.transfers" :key="`${event.id}-${transfer.sourceBatchId}-${transfer.targetBatchId}`" class="muted" style="font-size: 13px">
              批次 {{ transfer.sourceBatchCode || transfer.sourceBatchId.slice(0, 8) }}
              {{ transfer.sourceQuantity }} {{ transfer.sourceUnit }}
              （{{ transfer.sourceMaterialName }}）
              →
              <router-link :to="`/batches/${transfer.targetBatchId}`">{{ transfer.targetBatchCode || transfer.targetBatchId.slice(0, 8) }}</router-link>
              {{ transfer.targetQuantity }} {{ transfer.targetUnit }}
              （{{ transfer.targetMaterialName }}）
            </div>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else description="该材料还没有规格拆分或合并记录" :image-size="70" />
      </section>
    </template>

    <SpecEventDialog v-if="material" v-model="dialogVisible" :mode="dialogMode" :material="material" @completed="load" />
  </div>
</template>
