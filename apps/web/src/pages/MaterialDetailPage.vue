<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { craftTypeLabels, statusLabels, type Material, type MaterialLineageEvent } from "@/types";

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const material = ref<(Material & { batches: any[] }) | null>(null);
const lineage = ref<MaterialLineageEvent[]>([]);

const eventLabels: Record<string, string> = { SPLIT: "规格拆分", MERGE: "规格合并" };
const actionLabels: Record<string, string> = { MOVED: "同单位迁移", CONVERTED: "跨单位换算" };

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

async function archive() {
  if (!material.value) return;
  try {
    await ElMessageBox.confirm("归档后材料不会出现在新建记录中，也不能新增批次或被项目需求引用。仅在无正库存时允许归档。", "确认归档", { type: "warning" });
    await request(`/materials/${route.params.id}/archive`, { method: "POST", body: { version: material.value.version } });
    ElMessage.success("材料已归档");
    await router.push("/materials");
  } catch (error: any) {
    if (error === "cancel" || error === "close") return;
    if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
      ElMessage.error("材料刚被其他操作修改，请刷新页面后重试");
      await load();
      return;
    }
    ElMessage.error(error instanceof ApiError ? error.message : "归档失败");
  }
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
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
          <el-button v-if="!material.archivedAt" type="warning" plain
            @click="router.push({ path: `/materials/${material.id}/lineage-ops`, query: { mode: 'split' } })">规格拆分</el-button>
          <el-button v-if="!material.archivedAt" type="warning" plain
            @click="router.push({ path: `/materials/${material.id}/lineage-ops`, query: { mode: 'merge' } })">规格合并</el-button>
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
          <el-descriptions-item label="状态">
            <el-tag :type="material.archivedAt ? 'info' : 'success'">{{ material.archivedAt ? "已归档（禁止新增引用）" : "使用中" }}</el-tag>
          </el-descriptions-item>
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
        <h2>规格谱系</h2>
        <p class="muted" style="margin-bottom: 12px">拆分与合并事件只追加、不可修改，逐批保留单位换算前后的数量映射。</p>
        <el-timeline v-if="lineage.length > 0">
          <el-timeline-item v-for="event in lineage" :key="event.id" :timestamp="`${formatDate(event.createdAt)} · 操作人 ${event.actorName}`"
            :type="event.eventType === 'SPLIT' ? 'primary' : 'warning'">
            <el-card shadow="never">
              <div style="margin-bottom: 8px">
                <el-tag size="small" :type="event.eventType === 'SPLIT' ? 'primary' : 'warning'">{{ eventLabels[event.eventType] }}</el-tag>
                <span style="margin-left: 8px">{{ event.reason }}</span>
              </div>
              <div style="margin-bottom: 8px">
                <el-tag v-for="m in event.materials" :key="m.materialId + m.role" size="small"
                  :type="m.role === 'TARGET' ? 'success' : 'info'" style="margin-right: 6px">
                  {{ m.role === "TARGET" ? "目标" : "来源" }}：{{ m.materialName }}（{{ m.stockUnit }}）
                </el-tag>
              </div>
              <el-table :data="event.batches" size="small" border>
                <el-table-column label="批次" width="180">
                  <template #default="{ row }">
                    <router-link v-if="row.sourceBatchId" :to="`/batches/${row.sourceBatchId}`">{{ row.sourceBatchCode || "旧批次" }}</router-link>
                  </template>
                </el-table-column>
                <el-table-column label="处理" width="120">
                  <template #default="{ row }">
                    <el-tag size="small" :type="row.action === 'CONVERTED' ? 'warning' : 'info'">{{ actionLabels[row.action] || row.action }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="换算前数量" width="150">
                  <template #default="{ row }">{{ row.fromQuantity }} {{ row.fromUnit }}</template>
                </el-table-column>
                <el-table-column label="换算后数量" width="150">
                  <template #default="{ row }">{{ row.toQuantity }} {{ row.toUnit }}</template>
                </el-table-column>
                <el-table-column label="承接批次">
                  <template #default="{ row }">
                    <router-link v-if="row.targetBatchId" :to="`/batches/${row.targetBatchId}`">{{ row.targetBatchCode || "新批次" }}</router-link>
                  </template>
                </el-table-column>
              </el-table>
            </el-card>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else description="该材料尚未发生过规格拆分或合并" :image-size="70" />
      </section>
    </template>
  </div>
</template>
