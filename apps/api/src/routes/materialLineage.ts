import type { FastifyInstance } from "fastify";
import {
  compareQuantities,
  materialMergeSchema,
  materialSplitSchema,
  quantitiesAreCompatible,
  convertQuantity,
  type StockUnit
} from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import type { DbClient } from "../lib/db.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";

type MaterialRow = {
  id: string;
  name: string;
  code: string | null;
  stock_unit: StockUnit;
  version: number;
  archived_at: Date | null;
};

type BatchRow = {
  id: string;
  material_id: string;
  batch_code: string | null;
  remaining_quantity: string;
  stock_unit: StockUnit;
  status: "ACTIVE" | "DEPLETED" | "ARCHIVED";
  notes: string | null;
};

type EventBatchInput = {
  sourceBatchId: string | null;
  targetBatchId: string | null;
  sourceMaterialId: string;
  targetMaterialId: string;
  action: "MOVED" | "CONVERTED";
  fromQuantity: string;
  fromUnit: StockUnit;
  toQuantity: string;
  toUnit: StockUnit;
};

/** 按 UUID 排序加锁，避免并发拆分/合并事务之间出现死锁。 */
function orderedIds(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

/** 预演单位换算，把精度溢出（不能整除到 6 位小数）映射成明确的 422 业务错误。 */
function previewConvert(quantity: string, from: StockUnit, to: StockUnit, context: string): string {
  try {
    return convertQuantity(quantity, from, to);
  } catch (error) {
    if (error instanceof Error && error.message === "QUANTITY_PRECISION_EXCEEDED") {
      throw new AppError(422, "QUANTITY_PRECISION_EXCEEDED",
        `${context}的数量 ${quantity} ${from} 换算到 ${to} 后超过 6 位小数精度，无法无损迁移，请先调整批次数量`);
    }
    throw new AppError(422, "UNIT_INCOMPATIBLE", `${context}的单位 ${from} 与目标单位 ${to} 不兼容`);
  }
}

async function lockMaterials(client: DbClient, ids: string[]): Promise<Map<string, MaterialRow>> {
  const result = new Map<string, MaterialRow>();
  for (const id of orderedIds(ids)) {
    const rows = await client.query<MaterialRow>(
      "SELECT id, name, code, stock_unit, version, archived_at FROM materials WHERE id = $1 FOR UPDATE",
      [id]
    );
    const row = rows.rows[0];
    if (!row) throw new AppError(404, "NOT_FOUND", "材料不存在");
    result.set(id, row);
  }
  return result;
}

async function insertMaterial(client: DbClient, profile: {
  code?: string | null;
  name: string;
  craftTypes: readonly string[];
  subtype?: string | null;
  stockUnit: StockUnit;
  lowStockThreshold?: string | null;
  defaultColorName?: string | null;
  defaultColorHex?: string | null;
  tags: string[] | undefined;
  notes?: string | null;
}): Promise<MaterialRow> {
  const inserted = await client.query<MaterialRow>(
    `INSERT INTO materials(code, name, craft_types, subtype, stock_unit, low_stock_threshold,
      default_color_name, default_color_hex, tags, notes)
     VALUES ($1, $2, $3::craft_type[], $4, $5::stock_unit, $6, $7, $8, $9::text[], $10)
     RETURNING id, name, code, stock_unit, version, archived_at`,
    [profile.code || null, profile.name, profile.craftTypes as string[], profile.subtype || null, profile.stockUnit,
     profile.lowStockThreshold ?? null, profile.defaultColorName || null, profile.defaultColorHex || null,
     profile.tags ?? [], profile.notes || null]
  );
  return inserted.rows[0]!;
}

async function createEvent(client: DbClient, params: {
  eventType: "SPLIT" | "MERGE";
  reason: string;
  actorUserId: string;
}): Promise<string> {
  const event = await client.query<{ id: string }>(
    "INSERT INTO material_events(event_type, reason, actor_user_id) VALUES ($1::material_event_type, $2, $3) RETURNING id",
    [params.eventType, params.reason, params.actorUserId]
  );
  return event.rows[0]!.id;
}

async function recordEventDetails(client: DbClient, eventId: string, params: {
  materials: { material: MaterialRow; role: "SOURCE" | "TARGET" }[];
  batches: EventBatchInput[];
}): Promise<void> {
  for (const entry of params.materials) {
    await client.query(
      `INSERT INTO material_event_materials(event_id, material_id, role, material_name, material_code, stock_unit)
       VALUES ($1, $2, $3, $4, $5, $6::stock_unit)`,
      [eventId, entry.material.id, entry.role, entry.material.name, entry.material.code, entry.material.stock_unit]
    );
  }
  let seq = 0;
  for (const batch of params.batches) {
    seq += 1;
    await client.query(
      `INSERT INTO material_event_batches(event_id, source_batch_id, target_batch_id, source_material_id, target_material_id,
         action, from_quantity, from_unit, to_quantity, to_unit, seq)
       VALUES ($1, $2, $3, $4, $5, $6::material_event_batch_action, $7, $8::stock_unit, $9, $10::stock_unit, $11)`,
      [eventId, batch.sourceBatchId, batch.targetBatchId, batch.sourceMaterialId, batch.targetMaterialId,
       batch.action, batch.fromQuantity, batch.fromUnit, batch.toQuantity, batch.toUnit, seq]
    );
  }
}

/**
 * 把一个批次迁移到目标材料。
 * - 同单位（MOVED）：批次直接改挂材料，历史流水原样保留、不新增流水；批次号冲突时清空并在备注留痕。
 * - 跨单位（CONVERTED）：旧批次转出余额并归档（流水不可变），
 *   按目标单位建立新批次并以 TRANSFER_IN 开账，单位换算逐批留痕。
 */
async function migrateBatch(client: DbClient, batch: BatchRow, targetMaterial: MaterialRow,
  context: { eventId: string; reason: string; actorUserId: string; usedTargetCodes: Set<string> }): Promise<EventBatchInput> {
  const { eventId, reason, actorUserId, usedTargetCodes } = context;
  if (batch.stock_unit === targetMaterial.stock_unit) {
    const normalizedCode = batch.batch_code?.toLowerCase();
    const codeConflict = normalizedCode ? usedTargetCodes.has(normalizedCode) : false;
    await client.query(
      "UPDATE batches SET material_id = $1, batch_code = $2, notes = $3, version = version + 1 WHERE id = $4",
      [
        targetMaterial.id,
        codeConflict ? null : batch.batch_code,
        codeConflict
          ? [`批次号 ${batch.batch_code} 在合并到材料 ${targetMaterial.name} 时冲突，原批次号留空`, batch.notes].filter(Boolean).join("\n")
          : batch.notes,
        batch.id
      ]
    );
    if (normalizedCode) usedTargetCodes.add(normalizedCode);
    return {
      sourceBatchId: batch.id, targetBatchId: batch.id, sourceMaterialId: batch.material_id,
      targetMaterialId: targetMaterial.id, action: "MOVED",
      fromQuantity: batch.remaining_quantity, fromUnit: batch.stock_unit,
      toQuantity: batch.remaining_quantity, toUnit: batch.stock_unit
    };
  }

  // 跨单位：旧批次余额转出并归档，历史流水与单位原样保留
  const converted = previewConvert(batch.remaining_quantity, batch.stock_unit, targetMaterial.stock_unit,
    `批次 ${batch.batch_code || batch.id}`);
  await client.query(
    `INSERT INTO stock_movements(batch_id, type, signed_quantity, stock_unit, before_quantity, after_quantity,
       reference_type, reference_id, reason, actor_user_id)
     VALUES ($1, 'TRANSFER_OUT', $2, $3::stock_unit, $4, 0, 'MATERIAL_EVENT', $5, $6, $7)`,
    [batch.id, `-${batch.remaining_quantity}`, batch.stock_unit, batch.remaining_quantity, eventId, reason, actorUserId]
  );
  await client.query(
    "UPDATE batches SET remaining_quantity = 0, status = 'ARCHIVED', version = version + 1 WHERE id = $1",
    [batch.id]
  );

  // 目标材料下建立承接批次，以换算后数量开账；其余档案字段（来源、位置、颜色等）原样复制。
  // 承接批次按目标单位开账，故 entry_unit 取目标单位；原始入库单位保留在旧批次上。
  const newBatch = await client.query(
    `INSERT INTO batches(material_id, batch_code, source_id, source_note, location_id, received_at, expiry_at,
      initial_quantity, remaining_quantity, stock_unit, entry_unit, total_cost, currency,
      initial_color_name, initial_color_hex, current_color_name, current_color_hex, color_updated_at, notes)
     SELECT $1, NULL, source_id, source_note, location_id, received_at, expiry_at,
            $2, $2, $3::stock_unit, $3::stock_unit, total_cost, currency,
            initial_color_name, initial_color_hex, current_color_name, current_color_hex, color_updated_at, notes
       FROM batches WHERE id = $4
     RETURNING id`,
    [targetMaterial.id, converted, targetMaterial.stock_unit, batch.id]
  );
  const newBatchId = newBatch.rows[0]!.id as string;
  await client.query(
    `INSERT INTO stock_movements(batch_id, type, signed_quantity, stock_unit, before_quantity, after_quantity,
       reference_type, reference_id, reason, actor_user_id)
     VALUES ($1, 'TRANSFER_IN', $2, $3::stock_unit, 0, $2, 'MATERIAL_EVENT', $4, $5, $6)`,
    [newBatchId, converted, targetMaterial.stock_unit, eventId, reason, actorUserId]
  );
  return {
    sourceBatchId: batch.id, targetBatchId: newBatchId, sourceMaterialId: batch.material_id,
    targetMaterialId: targetMaterial.id, action: "CONVERTED",
    fromQuantity: batch.remaining_quantity, fromUnit: batch.stock_unit,
    toQuantity: converted, toUnit: targetMaterial.stock_unit
  };
}

/** 迁移后把来源材料的项目需求改挂到目标材料，计划数量按单位族换算。 */
async function reassignRequirements(client: DbClient, sourceMaterialId: string, targetMaterial: MaterialRow): Promise<void> {
  const requirements = await client.query<{ id: string; required_quantity: string; stock_unit: StockUnit }>(
    "SELECT id, required_quantity::text AS required_quantity, stock_unit FROM project_requirements WHERE material_id = $1 FOR UPDATE",
    [sourceMaterialId]
  );
  for (const requirement of requirements.rows) {
    const converted = previewConvert(requirement.required_quantity, requirement.stock_unit, targetMaterial.stock_unit,
      `项目需求 ${requirement.id}`);
    await client.query(
      "UPDATE project_requirements SET material_id = $1, required_quantity = $2, stock_unit = $3::stock_unit WHERE id = $4",
      [targetMaterial.id, converted, targetMaterial.stock_unit, requirement.id]
    );
  }
}

/** 迁移完成后把已无任何非归档批次的来源材料归档。 */
async function archiveMaterialIfEmpty(client: DbClient, materialId: string): Promise<boolean> {
  const remaining = await client.query(
    "SELECT 1 FROM batches WHERE material_id = $1 AND status <> 'ARCHIVED' LIMIT 1",
    [materialId]
  );
  if (remaining.rowCount) return false;
  const result = await client.query(
    "UPDATE materials SET archived_at = now(), version = version + 1 WHERE id = $1 AND archived_at IS NULL",
    [materialId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function materialLineageRoutes(app: FastifyInstance): Promise<void> {
  // 材料谱系时间线：反查该材料参与过的全部拆分/合并事件（含批次与单位映射明细）
  app.get<{ Params: { id: string } }>("/materials/:id/lineage", async (request) => {
    const exists = await pool.query("SELECT 1 FROM materials WHERE id = $1", [request.params.id]);
    if (!exists.rowCount) throw new AppError(404, "NOT_FOUND", "材料不存在");
    const events = await pool.query(
      `SELECT e.id, e.event_type AS "eventType", e.reason, e.created_at AS "createdAt",
              u.display_name AS "actorName"
         FROM material_events e
         JOIN material_event_materials mem ON mem.event_id = e.id
         JOIN users u ON u.id = e.actor_user_id
        WHERE mem.material_id = $1
        ORDER BY e.created_at DESC, e.id DESC`,
      [request.params.id]
    );
    const eventIds = events.rows.map((row: { id: string }) => row.id);
    if (eventIds.length === 0) return { data: [] };
    const materialRows = await pool.query(
      `SELECT mem.event_id AS "eventId", mem.material_id AS "materialId", mem.role,
              mem.material_name AS "materialName", mem.material_code AS "materialCode", mem.stock_unit AS "stockUnit"
         FROM material_event_materials mem
        WHERE mem.event_id = ANY($1::uuid[])
        ORDER BY mem.event_id, mem.id`,
      [eventIds]
    );
    const batchRows = await pool.query(
      `SELECT eb.event_id AS "eventId", eb.source_batch_id AS "sourceBatchId", eb.target_batch_id AS "targetBatchId",
              eb.source_material_id AS "sourceMaterialId", eb.target_material_id AS "targetMaterialId",
              eb.action, eb.from_quantity::text AS "fromQuantity", eb.from_unit AS "fromUnit",
              eb.to_quantity::text AS "toQuantity", eb.to_unit AS "toUnit",
              sb.batch_code AS "sourceBatchCode", tb.batch_code AS "targetBatchCode"
         FROM material_event_batches eb
         LEFT JOIN batches sb ON sb.id = eb.source_batch_id
         LEFT JOIN batches tb ON tb.id = eb.target_batch_id
        WHERE eb.event_id = ANY($1::uuid[])
        ORDER BY eb.event_id, eb.seq`,
      [eventIds]
    );
    const data = events.rows.map((event) => ({
      ...event,
      materials: materialRows.rows.filter((row) => row.eventId === event.id),
      batches: batchRows.rows.filter((row) => row.eventId === event.id)
    }));
    return { data };
  });

  // 规格拆分：来源材料 -> 新建的不同规格材料，按批次迁移并保留单位映射
  app.post<{ Params: { id: string } }>("/materials/:id/split", async (request) => {
    const input = parseInput(materialSplitSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      // 归档约束触发器为 DEFERRABLE，同事务内先迁移批次再归档来源需要推迟到提交时校验
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      const materials = await lockMaterials(client, [request.params.id]);
      const source = materials.get(request.params.id)!;
      if (source.archived_at) throw new AppError(409, "MATERIAL_ARCHIVED", "已归档材料不能拆分");
      if (source.version !== input.version) {
        throw new AppError(409, "VERSION_CONFLICT", "材料已被其他操作修改，请刷新后重试");
      }
      if (!quantitiesAreCompatible(source.stock_unit, input.newMaterial.stockUnit)) {
        throw new AppError(422, "UNIT_INCOMPATIBLE", `新规格单位 ${input.newMaterial.stockUnit} 与来源单位 ${source.stock_unit} 不属于同一单位族`);
      }

      const distinctBatchIds = [...new Set(input.batchIds)];
      const batchResult = await client.query<BatchRow>(
        `SELECT id, material_id, batch_code, remaining_quantity::text AS remaining_quantity, stock_unit, status, notes
           FROM batches WHERE id = ANY($1::uuid[]) FOR UPDATE`,
        [distinctBatchIds]
      );
      if (batchResult.rowCount !== distinctBatchIds.length) {
        throw new AppError(422, "BATCH_NOT_FOUND", "部分批次不存在");
      }
      const batches = new Map(batchResult.rows.map((row) => [row.id, row]));
      for (const batchId of distinctBatchIds) {
        const batch = batches.get(batchId)!;
        if (batch.material_id !== source.id) throw new AppError(422, "BATCH_NOT_FROM_MATERIAL", "只能拆分本材料名下的批次");
        if (batch.status === "ARCHIVED") throw new AppError(409, "BATCH_ARCHIVED", "已归档批次不能参与拆分");
        if (!quantitiesAreCompatible(batch.stock_unit, input.newMaterial.stockUnit)) {
          throw new AppError(422, "UNIT_INCOMPATIBLE", `批次 ${batch.batch_code || batch.id} 的单位与新规格不兼容`);
        }
        if (batch.stock_unit !== input.newMaterial.stockUnit && compareQuantities(batch.remaining_quantity, "0") === 0) {
          throw new AppError(422, "EMPTY_BATCH_CONVERSION", "跨单位拆分时零余额批次无法建立承接批次，请只选择有余额的批次或保持同单位迁移");
        }
        if (batch.stock_unit !== input.newMaterial.stockUnit) {
          previewConvert(batch.remaining_quantity, batch.stock_unit, input.newMaterial.stockUnit,
            `批次 ${batch.batch_code || batch.id}`);
        }
      }

      const target = await insertMaterial(client, { ...input.newMaterial, tags: input.newMaterial.tags ?? [] });
      await writeAudit(client, {
        actorUserId: user.id, action: "CREATE", entityType: "MATERIAL", entityId: target.id,
        afterData: { id: target.id, name: target.name, stockUnit: target.stock_unit, via: "SPLIT", sourceMaterialId: source.id },
        requestId: request.id
      });

      const eventId = await createEvent(client, { eventType: "SPLIT", reason: input.reason, actorUserId: user.id });
      const usedCodes = new Set<string>();
      const eventBatches: EventBatchInput[] = [];
      for (const batchId of distinctBatchIds) {
        eventBatches.push(await migrateBatch(client, batches.get(batchId)!, target,
          { eventId, reason: input.reason, actorUserId: user.id, usedTargetCodes: usedCodes }));
      }
      await recordEventDetails(client, eventId, {
        materials: [{ material: source, role: "SOURCE" }, { material: target, role: "TARGET" }],
        batches: eventBatches
      });

      await client.query("UPDATE materials SET version = version + 1 WHERE id = $1", [source.id]);
      let sourceArchived = false;
      if (input.archiveSourceWhenEmpty) sourceArchived = await archiveMaterialIfEmpty(client, source.id);
      await writeAudit(client, {
        actorUserId: user.id, action: "SPLIT", entityType: "MATERIAL", entityId: source.id,
        afterData: { eventId, targetMaterialId: target.id, batchCount: eventBatches.length, sourceArchived },
        requestId: request.id
      });

      return {
        data: {
          eventId,
          targetMaterial: { id: target.id, name: target.name, stockUnit: target.stock_unit, version: target.version },
          sourceArchived
        }
      };
    });
  });

  // 规格合并：一个或多个来源材料 -> 一个现有目标材料，逐批迁移并保留单位映射
  app.post("/materials/merge", async (request) => {
    const input = parseInput(materialMergeSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      const sourceIds = [...new Set(input.sourceMaterialIds)];
      if (sourceIds.includes(input.targetMaterialId)) {
        throw new AppError(422, "MERGE_TARGET_IS_SOURCE", "目标材料不能同时是来源材料");
      }
      const materials = await lockMaterials(client, [...sourceIds, input.targetMaterialId]);
      const target = materials.get(input.targetMaterialId)!;
      if (target.archived_at) throw new AppError(409, "MATERIAL_ARCHIVED", "已归档材料不能作为合并目标");
      if (target.version !== input.targetVersion) {
        throw new AppError(409, "VERSION_CONFLICT", "目标材料已被其他操作修改，请刷新后重试");
      }
      for (const sourceId of sourceIds) {
        const source = materials.get(sourceId)!;
        if (source.archived_at) throw new AppError(409, "MATERIAL_ARCHIVED", `来源材料 ${source.name} 已归档，不能参与合并`);
        if (sourceIds.length === 1 && source.version !== input.version) {
          throw new AppError(409, "VERSION_CONFLICT", "来源材料已被其他操作修改，请刷新后重试");
        }
        if (!quantitiesAreCompatible(source.stock_unit, target.stock_unit)) {
          throw new AppError(422, "UNIT_INCOMPATIBLE", `材料 ${source.name} 的单位与目标单位不属于同一单位族`);
        }
      }

      const batchResult = await client.query<BatchRow>(
        `SELECT id, material_id, batch_code, remaining_quantity::text AS remaining_quantity, stock_unit, status, notes
           FROM batches WHERE material_id = ANY($1::uuid[]) AND status <> 'ARCHIVED'
           ORDER BY material_id, created_at
           FOR UPDATE`,
        [sourceIds]
      );
      if (batchResult.rowCount === 0) {
        throw new AppError(409, "NO_BATCHES_TO_MERGE", "来源材料没有可合并的非归档批次");
      }
      for (const batch of batchResult.rows) {
        if (!quantitiesAreCompatible(batch.stock_unit, target.stock_unit)) {
          throw new AppError(422, "UNIT_INCOMPATIBLE", `批次 ${batch.batch_code || batch.id} 的单位与目标规格不兼容`);
        }
        if (batch.stock_unit !== target.stock_unit && compareQuantities(batch.remaining_quantity, "0") === 0) {
          throw new AppError(422, "EMPTY_BATCH_CONVERSION", "跨单位合并时来源存在零余额批次，请先耗尽归档或改用同单位目标");
        }
        if (batch.stock_unit !== target.stock_unit) {
          previewConvert(batch.remaining_quantity, batch.stock_unit, target.stock_unit,
            `批次 ${batch.batch_code || batch.id}`);
        }
      }

      const existingCodes = await client.query<{ code: string }>(
        "SELECT lower(batch_code) AS code FROM batches WHERE material_id = $1 AND batch_code IS NOT NULL",
        [target.id]
      );
      const usedCodes = new Set(existingCodes.rows.map((row) => row.code));

      const eventId = await createEvent(client, { eventType: "MERGE", reason: input.reason, actorUserId: user.id });
      const eventBatches: EventBatchInput[] = [];
      for (const batch of batchResult.rows) {
        eventBatches.push(await migrateBatch(client, batch, target,
          { eventId, reason: input.reason, actorUserId: user.id, usedTargetCodes: usedCodes }));
      }
      await recordEventDetails(client, eventId, {
        materials: [
          ...sourceIds.map((id) => ({ material: materials.get(id)!, role: "SOURCE" as const })),
          { material: target, role: "TARGET" as const }
        ],
        batches: eventBatches
      });

      const archivedSources: string[] = [];
      for (const sourceId of sourceIds) {
        await reassignRequirements(client, sourceId, target);
        await client.query("UPDATE materials SET version = version + 1 WHERE id = $1", [sourceId]);
        if (input.archiveSourceWhenEmpty && await archiveMaterialIfEmpty(client, sourceId)) archivedSources.push(sourceId);
      }
      await client.query("UPDATE materials SET version = version + 1 WHERE id = $1", [target.id]);
      await writeAudit(client, {
        actorUserId: user.id, action: "MERGE", entityType: "MATERIAL", entityId: target.id,
        afterData: { eventId, sourceMaterialIds: sourceIds, archivedSources, batchCount: eventBatches.length },
        requestId: request.id
      });

      return { data: { eventId, targetMaterialId: target.id, archivedSources, batchCount: eventBatches.length } };
    });
  });
}
