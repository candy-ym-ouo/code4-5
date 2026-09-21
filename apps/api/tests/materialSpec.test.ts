import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/lib/db.js";
import { createSession } from "../src/lib/auth.js";
import type { FastifyInstance } from "fastify";

const dbUrl = process.env.DATABASE_URL;

const maybe = dbUrl ? describe : describe.skip;

maybe("材料规格拆分与合并 (真实 PostgreSQL)", () => {
  let app: FastifyInstance;
  let cookie: string;
  let userId: string;

  async function reset() {
    await pool.query(`
      TRUNCATE material_spec_batch_transfers, material_spec_event_materials, material_spec_events,
        stock_movements, color_changes, attachments, consumptions, project_requirements, projects,
        batches, materials, audit_logs, sessions, users RESTART IDENTITY CASCADE`);
    const result = await pool.query("INSERT INTO users(display_name, password_hash) VALUES ('操作员','x') RETURNING id");
    userId = result.rows[0].id;
    const { token } = await createSession(userId);
    cookie = `handcraft_session=${token}`;
  }

  beforeAll(async () => {
    app = await buildApp();
    await reset();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  type Json = Record<string, any>;

  async function call(method: string, path: string, body?: Json) {
    const response = await app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { cookie, "content-type": "application/json" },
      payload: body ? JSON.stringify(body) : undefined
    });
    let payload: any = {};
    try { payload = response.json(); } catch { /* empty */ }
    return { status: response.statusCode, payload };
  }

  async function createMaterial(name: string, stockUnit: string, code?: string) {
    const response = await call("POST", "/materials", { name, code, craftTypes: ["GENERAL"], stockUnit });
    assert.equal(response.status, 201, JSON.stringify(response.payload));
    return response.payload.data;
  }

  async function createBatch(materialId: string, initialQuantity: string, entryUnit: string, batchCode?: string) {
    const response = await call("POST", "/batches", {
      materialId, batchCode, receivedAt: "2026-09-01", initialQuantity, entryUnit
    });
    assert.equal(response.status, 201, JSON.stringify(response.payload));
    return response.payload.data;
  }

  it("拆分：整批转入新目标，来源自动归档，谱系与批次映射可追溯", async () => {
    await reset();
    const source = await createMaterial("苏木", "g", "SRC-1");
    const target = await createMaterial("苏木细粉", "g", "TGT-1");
    const batch = await createBatch(source.id, "1000", "g", "B-SPLIT");

    const split = await call("POST", `/materials/${source.id}/split`, {
      version: source.version,
      reason: "按研磨粒度拆分档案",
      targets: [{ materialId: target.id, version: target.version }],
      transfers: [{ sourceBatchId: batch.id, targetMaterialOrdinal: 0, quantity: "1000", unit: "g" }]
    });
    assert.equal(split.status, 201, JSON.stringify(split.payload));
    const eventId = split.payload.data.eventId;

    const sourceDetail = await call("GET", `/materials/${source.id}`);
    assert.ok(sourceDetail.payload.data.archivedAt);
    assert.equal(sourceDetail.payload.data.version, source.version + 1);

    const targetDetail = await call("GET", `/materials/${target.id}`);
    assert.equal(targetDetail.payload.data.remainingQuantity, "1000.000000");
    assert.equal(targetDetail.payload.data.batches[0].batchCode, "B-SPLIT");
    assert.equal(targetDetail.payload.data.batches[0].remainingQuantity, "1000.000000");

    const lineage = await call("GET", `/materials/${source.id}/lineage`);
    assert.equal(lineage.status, 200);
    const event = lineage.payload.data[0];
    assert.equal(event.eventType, "SPLIT");
    assert.equal(event.transfers[0].sourceQuantity, "1000.000000");
    assert.equal(event.transfers[0].targetQuantity, "1000.000000");
    assert.equal(event.transfers[0].sourceUnit, "g");
    assert.equal(event.participants.length, 2);
    assert.equal(event.id, eventId);

    // 来源批次详情仍可通过 SPEC_TRANSFER_OUT 流水与映射追溯到新档案。
    const oldBatch = await call("GET", `/batches/${batch.id}`);
    const outMovement = oldBatch.payload.data.movements.find((m: any) => m.type === "SPEC_TRANSFER_OUT");
    assert.ok(outMovement);
    assert.equal(outMovement.referenceId, eventId);
    assert.equal(oldBatch.payload.data.status, "DEPLETED");
    const transfer = oldBatch.payload.data.specTransfers[0];
    assert.equal(transfer.direction, "SOURCE");
    assert.equal(transfer.targetMaterialId, target.id);
  });

  it("拆分：跨单位 kg→g 换算；部分转出保留库存且来源不归档", async () => {
    await reset();
    const source = await createMaterial("染料", "kg", "SRC-2");
    const target = await createMaterial("染料克装", "g", "TGT-2");
    const batch = await createBatch(source.id, "2", "kg", "B-KG");

    const split = await call("POST", `/materials/${source.id}/split`, {
      version: source.version,
      reason: "克装规格",
      targets: [{ materialId: target.id, version: target.version }],
      transfers: [{ sourceBatchId: batch.id, targetMaterialOrdinal: 0, quantity: "1.5", unit: "kg" }]
    });
    assert.equal(split.status, 201, JSON.stringify(split.payload));

    const sourceDetail = await call("GET", `/materials/${source.id}`);
    assert.equal(sourceDetail.payload.data.archivedAt, null);
    assert.equal(sourceDetail.payload.data.remainingQuantity, "0.500000");
    const targetDetail = await call("GET", `/materials/${target.id}`);
    assert.equal(targetDetail.payload.data.remainingQuantity, "1500.000000");

    const lineage = await call("GET", `/materials/${target.id}/lineage`);
    const transfer = lineage.payload.data[0].transfers[0];
    assert.equal(transfer.sourceUnit, "kg");
    assert.equal(transfer.targetUnit, "g");
    assert.equal(transfer.sourceQuantity, "1.500000");
    assert.equal(transfer.targetQuantity, "1500.000000");
  });

  it("拆分支持在同一事务中新建目标材料", async () => {
    await reset();
    const source = await createMaterial("原蜡", "g", "SRC-NEW");
    const batch = await createBatch(source.id, "100", "g", "B-NEW");
    const split = await call("POST", `/materials/${source.id}/split`, {
      version: source.version,
      reason: "新规格建档",
      targets: [{ material: { name: "新蜡档案", craftTypes: ["GENERAL"], stockUnit: "g" } }],
      transfers: [{ sourceBatchId: batch.id, targetMaterialOrdinal: 0, quantity: "100", unit: "g" }]
    });
    assert.equal(split.status, 201, JSON.stringify(split.payload));
    const lineage = await call("GET", `/materials/${source.id}/lineage`);
    assert.equal(lineage.payload.data[0].participants.find((p: any) => p.role === "TARGET").nameSnapshot, "新蜡档案");
  });

  it("并发编辑：来源材料版本过期时拆分返回 409 VERSION_CONFLICT，且无任何写入", async () => {
    await reset();
    const source = await createMaterial("乐观锁来源", "g", "SRC-VER");
    const target = await createMaterial("乐观锁目标", "g", "TGT-VER");
    const batch = await createBatch(source.id, "10", "g", "B-VER");

    // 其他操作先推进了来源材料版本。
    const patch = await call("PATCH", `/materials/${source.id}`, { version: source.version, name: "乐观锁来源-改" });
    assert.equal(patch.status, 200);
    // 目标材料也被并发修改。
    const patchTarget = await call("PATCH", `/materials/${target.id}`, { version: target.version, name: "乐观锁目标-改" });
    assert.equal(patchTarget.status, 200);

    const stale = await call("POST", `/materials/${source.id}/split`, {
      version: source.version,
      reason: "过期版本拆分",
      targets: [{ materialId: target.id, version: target.version }],
      transfers: [{ sourceBatchId: batch.id, targetMaterialOrdinal: 0, quantity: "10", unit: "g" }]
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.payload.error.code, "VERSION_CONFLICT");

    const events = await pool.query("SELECT count(*)::int c FROM material_spec_events");
    assert.equal(events.rows[0].c, 0);
    const untouched = await call("GET", `/batches/${batch.id}`);
    assert.equal(untouched.payload.data.remainingQuantity, "10.000000");

    // 来源版本正确、目标材料版本过期同样被拒绝。
    const staleTarget = await call("POST", `/materials/${source.id}/split`, {
      version: source.version + 1,
      reason: "目标版本过期",
      targets: [{ materialId: target.id, version: target.version }],
      transfers: [{ sourceBatchId: batch.id, targetMaterialOrdinal: 0, quantity: "10", unit: "g" }]
    });
    assert.equal(staleTarget.status, 409);
    assert.equal(staleTarget.payload.error.code, "VERSION_CONFLICT");
  });

  it("归档：缺少/错误版本被拒绝；归档后禁止新增批次与需求引用", async () => {
    await reset();
    const material = await createMaterial("待归档", "g", "ARC-1");
    await createBatch(material.id, "5", "g", "B-USED");
    // 先耗尽库存才能归档。
    const deplete = await call("POST", `/batches/${(await call("GET", `/materials/${material.id}`)).payload.data.batches[0].id}/adjustments`, {
      direction: "OUT", quantity: "5", unit: "g", reason: "盘库清零以便归档测试", version: 1
    });
    assert.equal(deplete.status, 201, JSON.stringify(deplete.payload));

    const noVersion = await call("POST", `/materials/${material.id}/archive`, {});
    assert.equal(noVersion.status, 422);

    const wrongVersion = await call("POST", `/materials/${material.id}/archive`, { version: material.version + 9 });
    assert.equal(wrongVersion.status, 409);
    assert.equal(wrongVersion.payload.error.code, "VERSION_CONFLICT");

    // 归档前先把批次 version 变化考虑进去（调整只动批次），材料 version 仍为 1。
    const archived = await call("POST", `/materials/${material.id}/archive`, { version: material.version });
    assert.equal(archived.status, 200, JSON.stringify(archived.payload));
    assert.ok(archived.payload.data.archived_at ?? archived.payload.data.archivedAt);

    const newBatch = await call("POST", "/batches", {
      materialId: material.id, receivedAt: "2026-09-20", initialQuantity: "1", entryUnit: "g"
    });
    assert.equal(newBatch.status, 422);
    assert.equal(newBatch.payload.error.code, "INVALID_MATERIAL");

    const project = await call("POST", "/projects", { name: "归档后引用项目", craftType: "GENERAL" });
    assert.equal(project.status, 201);
    const requirement = await call("POST", `/projects/${project.payload.data.id}/requirements`, {
      materialId: material.id, requiredQuantity: "1", unit: "g"
    });
    assert.equal(requirement.status, 422);
    assert.equal(requirement.payload.error.code, "INVALID_MATERIAL");

    const splitFromArchived = await call("POST", `/materials/${material.id}/split`, {
      version: 2, reason: "归档材料不能拆分", targets: [{ material: { name: "X", craftTypes: ["GENERAL"], stockUnit: "g" } }],
      transfers: [{ sourceBatchId: "00000000-0000-0000-0000-000000000001", targetMaterialOrdinal: 0, quantity: "1", unit: "g" }]
    });
    assert.equal(splitFromArchived.status, 409);
    assert.equal(splitFromArchived.payload.error.code, "MATERIAL_ARCHIVED");
  });

  it("合并：多个来源整批转入既有目标，历史批次仍归属原档案且来源自动归档", async () => {
    await reset();
    const a = await createMaterial("大桶木蜡油", "ml", "MRG-A");
    const b = await createMaterial("升装木蜡油", "l", "MRG-B");
    const target = await createMaterial("木蜡油总档案", "ml", "MRG-T");
    const ba = await createBatch(a.id, "900", "ml", "BA");
    const bb = await createBatch(b.id, "1", "l", "BB");

    const merge = await call("POST", "/materials/merge", {
      targetMaterialId: target.id, version: target.version, reason: "供应商规格合并",
      sources: [
        { materialId: a.id, version: a.version },
        { materialId: b.id, version: b.version }
      ]
    });
    assert.equal(merge.status, 201, JSON.stringify(merge.payload));

    const targetDetail = await call("GET", `/materials/${target.id}`);
    assert.equal(targetDetail.payload.data.remainingQuantity, "1900.000000");
    const codes = targetDetail.payload.data.batches.map((x: any) => x.batchCode).sort();
    assert.deepEqual(codes, ["BA", "BB"]);

    // 旧批次 material_id 保持不变 → 历史消耗/项目需求始终可追溯原档案与原单位。
    const oldA = await call("GET", `/batches/${ba.id}`);
    assert.equal(oldA.payload.data.materialId, a.id);
    assert.equal(oldA.payload.data.status, "DEPLETED");
    const oldB = await call("GET", `/batches/${bb.id}`);
    assert.equal(oldB.payload.data.materialId, b.id);
    assert.equal(oldB.payload.data.specTransfers[0].sourceUnit, "l");
    assert.equal(oldB.payload.data.specTransfers[0].targetUnit, "ml");

    for (const id of [a.id, b.id]) {
      const detail = await call("GET", `/materials/${id}`);
      assert.ok(detail.payload.data.archivedAt);
    }
    const targetLineage = await call("GET", `/materials/${target.id}/lineage`);
    assert.equal(targetLineage.payload.data[0].eventType, "MERGE");
    assert.equal(targetLineage.payload.data[0].transfers.length, 2);
  });

  it("合并：无在库批次的来源被拒绝；目标出现在来源中被拒绝", async () => {
    await reset();
    const empty = await createMaterial("空来源", "g", "MRG-EMPTY");
    const target = await createMaterial("合并目标", "g", "MRG-T2");

    const noStock = await call("POST", "/materials/merge", {
      targetMaterialId: target.id, version: target.version, reason: "没有可转库存",
      sources: [{ materialId: empty.id, version: empty.version }]
    });
    assert.equal(noStock.status, 409);
    assert.equal(noStock.payload.error.code, "NO_STOCK_TO_MERGE");

    const self = await call("POST", "/materials/merge", {
      targetMaterialId: target.id, version: target.version, reason: "自己合自己",
      sources: [{ materialId: target.id, version: target.version }]
    });
    assert.equal(self.status, 422);
  });

  it("拆分幂等：相同 Idempotency-Key 重试不重复产生批次", async () => {
    await reset();
    const source = await createMaterial("幂等来源", "g", "IDEM-S");
    const target = await createMaterial("幂等目标", "g", "IDEM-T");
    const batch = await createBatch(source.id, "100", "g", "B-IDEM");
    const body = {
      version: source.version, reason: "幂等拆分",
      targets: [{ materialId: target.id, version: target.version }],
      transfers: [{ sourceBatchId: batch.id, targetMaterialOrdinal: 0, quantity: "100", unit: "g" }]
    };
    const first = await app.inject({
      method: "POST", url: `/api/v1/materials/${source.id}/split`,
      headers: { cookie, "content-type": "application/json", "idempotency-key": "spec-key-1" },
      payload: JSON.stringify(body)
    });
    assert.equal(first.statusCode, 201);
    const second = await app.inject({
      method: "POST", url: `/api/v1/materials/${source.id}/split`,
      headers: { cookie, "content-type": "application/json", "idempotency-key": "spec-key-1" },
      payload: JSON.stringify(body)
    });
    assert.equal(second.statusCode, 200);
    const targetDetail = await call("GET", `/materials/${target.id}`);
    assert.equal(targetDetail.payload.data.batchCount, 1);
    assert.equal(await pool.query("SELECT count(*)::int c FROM material_spec_events").then((r) => r.rows[0].c), 1);
  });
});
