import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  addQuantities,
  compareQuantities,
  convertQuantity,
  materialInputSchema,
  materialMergeSchema,
  materialSplitSchema,
  quantitiesAreCompatible,
  subtractQuantities,
  type MaterialSpecEventType,
  type StockUnit
} from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction, type DbClient } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";
import { getIdempotencyKey } from "../lib/idempotency.js";

type MaterialInput = z.input<typeof materialInputSchema>;

type MaterialRow = {
  id: string;
  code: string | null;
  name: string;
  craft_types: string[];
  subtype: string | null;
  stock_unit: StockUnit;
  low_stock_threshold: string | null;
  default_color_name: string | null;
  default_color_hex: string | null;
  tags: string[];
  notes: string | null;
  archived_at: Date | null;
  version: number;
};

type BatchRow = {
  id: string;
  material_id: string;
  batch_code: string | null;
  source_id: string | null;
  source_note: string | null;
  location_id: string | null;
  received_at: Date;
  expiry_at: Date | null;
  initial_quantity: string;
  remaining_quantity: string;
  stock_unit: StockUnit;
  entry_unit: StockUnit;
  initial_color_name: string | null;
  initial_color_hex: string | null;
  current_color_name: string | null;
  current_color_hex: string | null;
  color_updated_at: Date | null;
  status: string;
  notes: string | null;
};

type ParticipantSpec = {
  materialId: string;
  expectedVersion: number;
  role: "SOURCE" | "TARGET";
  ordinal: number;
};

type NewTargetSpec = {
  ordinal: number;
  input: MaterialInput;
};

// 转出数量按申报单位给出，在事务内换算到批次库存单位；目标材料以序号引用（拆分可在同事务新建目标）。
type TransferRequest = {
  sourceBatchId: string;
  targetOrdinal: number;
  quantity: string;
  unit: StockUnit;
};

type EventRequest = {
  eventType: MaterialSpecEventType;
  reason: string;
  idempotencyKey?: string;
  user: { id: string };
  requestId: string;
  participants: ParticipantSpec[];
  newTargets: NewTargetSpec[];
  transfers: TransferRequest[];
  // 合并时按来源材料整批转出：提供来源材料 id，事务内锁定其全部在库批次。
  mergeSourceMaterialIds?: string[];
};

async function lockMaterials(
  client: DbClient,
  participants: ParticipantSpec[]
): Promise<Map<string, MaterialRow & { role: string; ordinal: number }>> {
  const result = new Map<string, MaterialRow & { role: string; ordinal: number }>();
  const uniqueIds = [...new Set(participants.map((participant) => participant.materialId))].sort();
  for (const materialId of uniqueIds) {
    const query = await client.query<MaterialRow>("SELECT * FROM materials WHERE id = $1 FOR UPDATE", [materialId]);
    const row = query.rows[0];
    if (!row) throw new AppError(404, "NOT_FOUND", "材料不存在");
    if (row.archived_at) throw new AppError(409, "MATERIAL_ARCHIVED", `已归档材料「${row.name}」不能参与规格拆分或合并`);
    // 同一材料不能同时充当来源和目标；每个材料在事件中只能有一个角色与序号。
    const specs = participants.filter((participant) => participant.materialId === materialId);
    const roles = new Set(specs.map((spec) => spec.role));
    if (roles.size > 1) throw new AppError(422, "SPEC_TARGET_IS_SOURCE", "目标材料不能同时是来源材料");
    const spec = specs[0]!;
    if (row.version !== spec.expectedVersion) {
      throw new AppError(409, "VERSION_CONFLICT", `材料「${row.name}」已被其他操作修改，请刷新后重试`);
    }
    result.set(materialId, { ...row, role: spec.role, ordinal: spec.ordinal });
  }
  return result;
}

async function executeSpecEvent(request: EventRequest): Promise<{ eventId: string; idempotent: boolean }> {
  const { eventType, reason, idempotencyKey, user } = request;
  return withTransaction(async (client) => {
    if (idempotencyKey) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [idempotencyKey]);
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM material_spec_events WHERE idempotency_key = $1 LIMIT 1",
        [idempotencyKey]
      );
      if (existing.rows[0]) return { eventId: existing.rows[0]!.id, idempotent: true };
    }

    const materials = await lockMaterials(client, request.participants);

    for (const newTarget of request.newTargets) {
      const created = await client.query<MaterialRow>(
        `INSERT INTO materials(code, name, craft_types, subtype, stock_unit, low_stock_threshold,
          default_color_name, default_color_hex, tags, notes)
         VALUES ($1, $2, $3::craft_type[], $4, $5::stock_unit, $6, $7, $8, $9::text[], $10)
         RETURNING *`,
        [newTarget.input.code || null, newTarget.input.name, newTarget.input.craftTypes, newTarget.input.subtype || null,
         newTarget.input.stockUnit, newTarget.input.lowStockThreshold ?? null, newTarget.input.defaultColorName || null,
         newTarget.input.defaultColorHex || null, newTarget.input.tags, newTarget.input.notes || null]
      );
      materials.set(created.rows[0]!.id, { ...created.rows[0]!, role: "TARGET", ordinal: newTarget.ordinal });
    }

    const targetsByOrdinal = new Map<number, MaterialRow & { role: string; ordinal: number }>();
    for (const material of materials.values()) {
      if (material.role === "TARGET") targetsByOrdinal.set(material.ordinal, material);
    }
    const sourceMaterialIds = new Set(
      [...materials.values()].filter((material) => material.role === "SOURCE").map((material) => material.id)
    );

    // 合并：在持有全部材料行锁之后枚举在库批次，避免与并发编辑产生竞争窗口。
    let transfers = request.transfers;
    if (request.mergeSourceMaterialIds?.length) {
      const mergeBatches: BatchRow[] = [];
      for (const sourceMaterialId of request.mergeSourceMaterialIds) {
        const query = await client.query<BatchRow>(
          "SELECT * FROM batches WHERE material_id = $1 AND status <> 'ARCHIVED' AND remaining_quantity > 0 ORDER BY id FOR UPDATE",
          [sourceMaterialId]
        );
        mergeBatches.push(...query.rows);
      }
      if (mergeBatches.length === 0) {
        throw new AppError(409, "NO_STOCK_TO_MERGE", "来源材料没有任何在库批次，无需合并；如需停用请直接归档");
      }
      transfers = mergeBatches.map((batch) => ({
        sourceBatchId: batch.id,
        targetOrdinal: 0,
        quantity: batch.remaining_quantity,
        unit: batch.stock_unit
      }));
    }

    // 先解析并校验全部转出：按批次 id 固定顺序加锁，避免并发规格操作互相死锁。
    const batchIds = [...new Set(transfers.map((transfer) => transfer.sourceBatchId))].sort();
    const sourceBatches = new Map<string, BatchRow>();
    if (batchIds.length) {
      const query = await client.query<BatchRow>(
        "SELECT * FROM batches WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [batchIds]
      );
      for (const row of query.rows) sourceBatches.set(row.id, row);
    }

    type ResolvedTransfer = { sourceBatch: BatchRow; targetMaterialId: string; sourceQuantity: string; targetQuantity: string };
    const requestedByBatch = new Map<string, string>();
    const resolvedTransfers: ResolvedTransfer[] = [];
    for (const transfer of transfers) {
      const sourceBatch = sourceBatches.get(transfer.sourceBatchId);
      if (!sourceBatch) throw new AppError(422, "INVALID_BATCH", "转出批次不存在或已归档");
      if (sourceBatch.status === "ARCHIVED") throw new AppError(409, "BATCH_ARCHIVED", "已归档批次不能参与规格拆分或合并");
      if (!sourceMaterialIds.has(sourceBatch.material_id)) {
        throw new AppError(422, "INVALID_BATCH", "只能转出本次来源材料下的批次");
      }
      const targetMaterial = targetsByOrdinal.get(transfer.targetOrdinal);
      if (!targetMaterial) throw new AppError(422, "INVALID_TARGET", "规格转入目标材料不存在");
      let sourceQuantity: string;
      try {
        sourceQuantity = convertQuantity(transfer.quantity, transfer.unit, sourceBatch.stock_unit);
      } catch {
        throw new AppError(422, "UNIT_INCOMPATIBLE", `批次 ${sourceBatch.batch_code ?? transfer.sourceBatchId} 的转出单位与批次库存单位不兼容`);
      }
      if (compareQuantities(sourceQuantity, "0") <= 0) throw new AppError(422, "INVALID_QUANTITY", "转出数量必须大于 0");
      if (!quantitiesAreCompatible(sourceBatch.stock_unit, targetMaterial.stock_unit)) {
        throw new AppError(422, "UNIT_INCOMPATIBLE", `目标材料「${targetMaterial.name}」与转出批次的单位不属于同一度量族`);
      }
      let targetQuantity: string;
      try {
        targetQuantity = convertQuantity(sourceQuantity, sourceBatch.stock_unit, targetMaterial.stock_unit);
      } catch {
        throw new AppError(422, "QUANTITY_PRECISION_EXCEEDED", `转入材料「${targetMaterial.name}」后数量超过 6 位小数精度，请调整转出数量`);
      }
      requestedByBatch.set(
        sourceBatch.id,
        addQuantities(requestedByBatch.get(sourceBatch.id) ?? "0", sourceQuantity)
      );
      resolvedTransfers.push({ sourceBatch, targetMaterialId: targetMaterial.id, sourceQuantity, targetQuantity });
    }
    for (const [batchId, requested] of requestedByBatch) {
      const batch = sourceBatches.get(batchId)!;
      if (compareQuantities(requested, batch.remaining_quantity) > 0) {
        throw new AppError(409, "INSUFFICIENT_STOCK", `批次 ${batch.batch_code ?? batchId} 可转出数量不足`);
      }
    }

    const event = await client.query<{ id: string }>(
      `INSERT INTO material_spec_events(event_type, reason, idempotency_key, actor_user_id)
       VALUES ($1::material_spec_event_type, $2, $3, $4) RETURNING id`,
      [eventType, reason, idempotencyKey, user.id]
    );
    const eventId = event.rows[0]!.id;

    for (const material of materials.values()) {
      await client.query(
        `INSERT INTO material_spec_event_materials
          (event_id, material_id, role, ordinal, version_before, name_snapshot, code_snapshot, stock_unit_snapshot)
         VALUES ($1, $2, $3::material_spec_role, $4, $5, $6, $7, $8::stock_unit)`,
        [eventId, material.id, material.role, material.ordinal, material.version, material.name, material.code, material.stock_unit]
      );
    }

    // 目标材料内的批次号唯一；冲突时追加来源批次短 id，保证新批次沿用可识别的历史批次号。
    const usedTargetCodes = new Map<string, Set<string>>();
    for (const targetId of [...targetsByOrdinal.values()].map((material) => material.id)) {
      const existing = await client.query<{ code: string | null }>(
        "SELECT lower(batch_code) AS code FROM batches WHERE material_id = $1 AND batch_code IS NOT NULL",
        [targetId]
      );
      usedTargetCodes.set(targetId, new Set(existing.rows.map((row) => row.code as string)));
    }

    const cumulativeOut = new Map<string, string>();
    const verb = eventType === "SPLIT" ? "规格拆分" : "规格合并";
    let ordinal = 0;
    for (const resolved of resolvedTransfers) {
      const { sourceBatch, targetMaterialId, sourceQuantity, targetQuantity } = resolved;
      const targetMaterial = materials.get(targetMaterialId)!;

      const alreadyOut = cumulativeOut.get(sourceBatch.id) ?? "0";
      const beforeQuantity = subtractQuantities(sourceBatch.remaining_quantity, alreadyOut);
      const afterQuantity = subtractQuantities(beforeQuantity, sourceQuantity);
      cumulativeOut.set(sourceBatch.id, addQuantities(alreadyOut, sourceQuantity));

      const codeSet = usedTargetCodes.get(targetMaterialId)!;
      let batchCode = sourceBatch.batch_code;
      if (batchCode) {
        if (codeSet.has(batchCode.toLowerCase())) batchCode = `${sourceBatch.batch_code}-${sourceBatch.id.slice(0, 8)}`;
        codeSet.add(batchCode.toLowerCase());
      }

      await client.query(
        `INSERT INTO stock_movements(batch_id, type, signed_quantity, stock_unit, before_quantity, after_quantity,
          reference_type, reference_id, reason, actor_user_id)
         VALUES ($1, 'SPEC_TRANSFER_OUT', $2, $3::stock_unit, $4, $5, 'MATERIAL_SPEC_EVENT', $6, $7, $8)`,
        [sourceBatch.id, `-${sourceQuantity}`, sourceBatch.stock_unit, beforeQuantity, afterQuantity, eventId,
         `${verb}转出至材料 ${targetMaterial.name}`, user.id]
      );

      const targetBatch = await client.query<BatchRow>(
        `INSERT INTO batches(material_id, batch_code, source_id, source_note, location_id, received_at, expiry_at,
          initial_quantity, remaining_quantity, stock_unit, entry_unit,
          initial_color_name, initial_color_hex, current_color_name, current_color_hex, color_updated_at, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9::stock_unit, $9::stock_unit, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
        [targetMaterialId, batchCode, sourceBatch.source_id, sourceBatch.source_note, sourceBatch.location_id,
         sourceBatch.received_at, sourceBatch.expiry_at, targetQuantity, targetMaterial.stock_unit,
         sourceBatch.initial_color_name, sourceBatch.initial_color_hex,
         sourceBatch.current_color_name, sourceBatch.current_color_hex, sourceBatch.color_updated_at,
         sourceBatch.notes ? `${verb}自规格事件转入；${sourceBatch.notes}` : `${verb}自规格事件转入`]
      );
      const targetBatchId = targetBatch.rows[0]!.id;

      await client.query(
        `INSERT INTO stock_movements(batch_id, type, signed_quantity, stock_unit, before_quantity, after_quantity,
          reference_type, reference_id, reason, actor_user_id)
         VALUES ($1, 'OPENING', $2, $3::stock_unit, 0, $2, 'MATERIAL_SPEC_EVENT', $4, $5, $6)`,
        [targetBatchId, targetQuantity, targetMaterial.stock_unit, eventId,
         `${verb}转入自批次 ${sourceBatch.batch_code ?? sourceBatch.id}（${sourceBatch.stock_unit} ${sourceQuantity}）`, user.id]
      );

      await client.query(
        `INSERT INTO material_spec_batch_transfers
          (event_id, ordinal, source_batch_id, target_batch_id, source_material_id, target_material_id,
           source_quantity, target_quantity, source_unit, target_unit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::stock_unit, $10::stock_unit)`,
        [eventId, ordinal, sourceBatch.id, targetBatchId, sourceBatch.material_id, targetMaterialId,
         sourceQuantity, targetQuantity, sourceBatch.stock_unit, targetMaterial.stock_unit]
      );
      ordinal += 1;
    }

    for (const [batchId, out] of cumulativeOut) {
      const batch = sourceBatches.get(batchId)!;
      const remaining = subtractQuantities(batch.remaining_quantity, out);
      const status = compareQuantities(remaining, "0") === 0 ? "DEPLETED" : "ACTIVE";
      await client.query("UPDATE batches SET remaining_quantity = $1, status = $2, version = version + 1 WHERE id = $3", [remaining, status, batchId]);
    }

    // 参与材料版本号统一推进；来源材料在全部有效批次结余为 0 时随事件自动归档。
    for (const material of materials.values()) {
      if (material.role === "SOURCE") {
        const stock = await client.query(
          "SELECT 1 FROM batches WHERE material_id = $1 AND status <> 'ARCHIVED' AND remaining_quantity > 0 LIMIT 1",
          [material.id]
        );
        if (!stock.rowCount) {
          await client.query("UPDATE materials SET archived_at = now(), version = version + 1 WHERE id = $1", [material.id]);
        } else {
          await client.query("UPDATE materials SET version = version + 1 WHERE id = $1", [material.id]);
        }
      } else {
        await client.query("UPDATE materials SET version = version + 1 WHERE id = $1", [material.id]);
      }
    }

    await writeAudit(client, {
      actorUserId: user.id,
      action: eventType === "SPLIT" ? "SPEC_SPLIT" : "SPEC_MERGE",
      entityType: "MATERIAL_SPEC_EVENT",
      entityId: eventId,
      afterData: { eventType, reason, transferCount: resolvedTransfers.length },
      requestId: request.requestId
    });

    return { eventId, idempotent: false };
  });
}

export async function materialSpecRoutes(app: FastifyInstance): Promise<void> {
  // 规格拆分：把来源材料的部分或全部批次库存转到一个或多个目标材料；未转完的库存仍保留在原档案。
  app.post<{ Params: { id: string } }>("/materials/:id/split", async (request, reply) => {
    const input = parseInput(materialSplitSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;

    const participants: ParticipantSpec[] = [
      { materialId: request.params.id, expectedVersion: input.version, role: "SOURCE", ordinal: 0 }
    ];
    const newTargets: NewTargetSpec[] = [];
    input.targets.forEach((target, index) => {
      if (target.materialId) {
        if (target.materialId === request.params.id) {
          throw new AppError(422, "SPEC_TARGET_IS_SOURCE", "拆分目标不能是来源材料本身");
        }
        participants.push({ materialId: target.materialId, expectedVersion: target.version ?? 1, role: "TARGET", ordinal: index });
      } else {
        newTargets.push({ ordinal: index, input: target.material! });
      }
    });

    const result = await executeSpecEvent({
      eventType: "SPLIT",
      reason: input.reason,
      idempotencyKey: getIdempotencyKey(request.headers),
      user,
      requestId: request.id,
      participants,
      newTargets,
      transfers: input.transfers.map((transfer) => ({
        sourceBatchId: transfer.sourceBatchId,
        targetOrdinal: transfer.targetMaterialOrdinal,
        quantity: transfer.quantity,
        unit: transfer.unit
      }))
    });
    return reply.status(result.idempotent ? 200 : 201).send({ data: { eventId: result.eventId } });
  });

  // 规格合并：把多个来源材料的全部在库批次整批转入一个既有目标材料，来源全部转出后自动归档。
  app.post("/materials/merge", async (request, reply) => {
    const input = parseInput(materialMergeSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;

    const result = await executeSpecEvent({
      eventType: "MERGE",
      reason: input.reason,
      idempotencyKey: getIdempotencyKey(request.headers),
      user,
      requestId: request.id,
      participants: [
        { materialId: input.targetMaterialId, expectedVersion: input.version, role: "TARGET", ordinal: 0 },
        ...input.sources.map((source, index) => ({
          materialId: source.materialId,
          expectedVersion: source.version,
          role: "SOURCE" as const,
          ordinal: index + 1
        }))
      ],
      newTargets: [],
      transfers: [],
      mergeSourceMaterialIds: input.sources.map((source) => source.materialId)
    });
    return reply.status(result.idempotent ? 200 : 201).send({ data: { eventId: result.eventId } });
  });

  // 规格谱系：返回该材料参与过的全部拆分/合并事件、当事材料快照与批次单位映射。
  app.get<{ Params: { id: string } }>("/materials/:id/lineage", async (request) => {
    const exists = await pool.query("SELECT 1 FROM materials WHERE id = $1", [request.params.id]);
    if (!exists.rowCount) throw new AppError(404, "NOT_FOUND", "材料不存在");

    const eventRows = await pool.query(
      `SELECT e.id, e.event_type AS "eventType", e.reason, e.created_at AS "createdAt",
              em.role, em.ordinal, em.version_before AS "versionBefore",
              em.name_snapshot AS "nameSnapshot", em.code_snapshot AS "codeSnapshot",
              em.stock_unit_snapshot AS "stockUnitSnapshot"
         FROM material_spec_events e
         JOIN material_spec_event_materials em ON em.event_id = e.id
        WHERE e.id IN (SELECT event_id FROM material_spec_event_materials WHERE material_id = $1)
        ORDER BY e.created_at DESC, em.role, em.ordinal`,
      [request.params.id]
    );
    const eventIds = [...new Set(eventRows.rows.map((row) => row.id as string))];
    const transferRows = eventIds.length
      ? await pool.query(
          `SELECT t.event_id AS "eventId", t.ordinal, t.source_batch_id AS "sourceBatchId",
                  t.target_batch_id AS "targetBatchId", t.source_material_id AS "sourceMaterialId",
                  t.target_material_id AS "targetMaterialId", t.source_quantity::text AS "sourceQuantity",
                  t.target_quantity::text AS "targetQuantity", t.source_unit AS "sourceUnit",
                  t.target_unit AS "targetUnit",
                  sb.batch_code AS "sourceBatchCode", tb.batch_code AS "targetBatchCode",
                  sm.name AS "sourceMaterialName", tm.name AS "targetMaterialName"
             FROM material_spec_batch_transfers t
             JOIN batches sb ON sb.id = t.source_batch_id
             JOIN batches tb ON tb.id = t.target_batch_id
             JOIN materials sm ON sm.id = t.source_material_id
             JOIN materials tm ON tm.id = t.target_material_id
            WHERE t.event_id = ANY($1::uuid[])
            ORDER BY t.event_id, t.ordinal`,
          [eventIds]
        )
      : { rows: [] };

    const transfersByEvent = new Map<string, unknown[]>();
    for (const row of transferRows.rows) {
      const list = transfersByEvent.get(row.eventId as string) ?? [];
      list.push(row);
      transfersByEvent.set(row.eventId as string, list);
    }
    const grouped = new Map<string, Record<string, unknown>>();
    for (const row of eventRows.rows) {
      const entry = grouped.get(row.id as string) ?? {
        id: row.id,
        eventType: row.eventType,
        reason: row.reason,
        createdAt: row.createdAt,
        participants: [],
        transfers: transfersByEvent.get(row.id as string) ?? []
      };
      (entry.participants as unknown[]).push({
        role: row.role,
        ordinal: row.ordinal,
        versionBefore: row.versionBefore,
        nameSnapshot: row.nameSnapshot,
        codeSnapshot: row.codeSnapshot,
        stockUnitSnapshot: row.stockUnitSnapshot
      });
      grouped.set(row.id as string, entry);
    }
    return { data: [...grouped.values()] };
  });
}
