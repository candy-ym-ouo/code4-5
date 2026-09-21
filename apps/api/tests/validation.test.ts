import { describe, expect, it } from "vitest";
import {
  archiveMaterialSchema,
  batchCreateSchema,
  colorChangeInputSchema,
  consumptionInputSchema,
  convertQuantity,
  materialMergeSchema,
  materialSplitSchema
} from "@handcraft/contracts";

describe("API business validation contracts", () => {
  it("normalizes a valid batch payload", () => {
    const result = batchCreateSchema.parse({
      materialId: "00000000-0000-0000-0000-000000000001",
      receivedAt: "2026-09-13",
      initialQuantity: "1.5",
      entryUnit: "kg"
    });
    expect(result.entryUnit).toBe("kg");
  });

  it("requires at least one consumption quantity", () => {
    const base = {
      projectId: "00000000-0000-0000-0000-000000000001",
      batchId: "00000000-0000-0000-0000-000000000002",
      usedQuantity: "0",
      wasteQuantity: "0",
      unit: "g"
    };
    expect(consumptionInputSchema.safeParse(base).success).toBe(false);
    expect(consumptionInputSchema.safeParse({ ...base, wasteQuantity: "10" }).success).toBe(true);
  });

  it("rejects zero affected quantity for color changes", () => {
    const result = colorChangeInputSchema.safeParse({
      batchId: "00000000-0000-0000-0000-000000000002",
      changeType: "OTHER",
      afterColorName: "Test",
      affectedQuantity: "0",
      unit: "g",
      occurredAt: "2026-09-13T10:00:00+08:00"
    });
    expect(result.success).toBe(false);
  });

  it("keeps inventory units in compatible families", () => {
    expect(convertQuantity("2.5", "l", "ml")).toBe("2500.000000");
    expect(() => convertQuantity("2.5", "l", "kg")).toThrow();
  });

  it("accepts a valid material split payload and defaults the archive flag", () => {
    const result = materialSplitSchema.parse({
      version: 3,
      reason: "线轴规格独立管理",
      batchIds: ["00000000-0000-0000-0000-000000000002"],
      newMaterial: {
        name: "苏木线轴",
        craftTypes: ["DYEING"],
        stockUnit: "kg"
      }
    });
    expect(result.archiveSourceWhenEmpty).toBe(true);
    expect(result.newMaterial.tags).toEqual([]);
  });

  it("requires a reason and at least one batch for splits", () => {
    const payload = {
      version: 1,
      reason: "x",
      batchIds: [],
      newMaterial: { name: "新规格", craftTypes: ["OTHER"], stockUnit: "g" }
    };
    expect(materialSplitSchema.safeParse(payload).success).toBe(false);
    expect(
      materialSplitSchema.safeParse({ ...payload, reason: "合理的拆分原因", batchIds: ["00000000-0000-0000-0000-000000000003"] }).success
    ).toBe(true);
  });

  it("accepts a valid merge payload with both optimistic versions", () => {
    const result = materialMergeSchema.parse({
      version: 2,
      targetVersion: 5,
      reason: "确认为同一规格进行合并",
      sourceMaterialIds: ["00000000-0000-0000-0000-000000000001"],
      targetMaterialId: "00000000-0000-0000-0000-000000000002"
    });
    expect(result.archiveSourceWhenEmpty).toBe(true);
  });

  it("rejects a merge without sources or target", () => {
    expect(
      materialMergeSchema.safeParse({
        version: 1,
        targetVersion: 1,
        reason: "合理的合并原因",
        sourceMaterialIds: [],
        targetMaterialId: "not-a-uuid"
      }).success
    ).toBe(false);
  });

  it("requires an optimistic version to archive a material", () => {
    expect(archiveMaterialSchema.safeParse({}).success).toBe(false);
    expect(archiveMaterialSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(archiveMaterialSchema.safeParse({ version: 4 }).success).toBe(true);
  });
});
