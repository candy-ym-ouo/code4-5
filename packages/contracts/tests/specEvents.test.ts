import { describe, expect, it } from "vitest";
import {
  materialArchiveSchema,
  materialMergeSchema,
  materialSplitSchema
} from "../src/index.js";

const uuid = "00000000-0000-0000-0000-000000000001";
const otherUuid = "00000000-0000-0000-0000-000000000002";

describe("material split schema", () => {
  const validTarget = {
    material: { name: "细粉", craftTypes: ["GENERAL"], stockUnit: "g" }
  };
  const valid = {
    version: 3,
    reason: "按粒度拆分",
    targets: [validTarget],
    transfers: [{ sourceBatchId: uuid, targetMaterialOrdinal: 0, quantity: "500", unit: "g" }]
  };

  it("accepts a payload with a newly created target material", () => {
    expect(materialSplitSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts an existing target material with version", () => {
    const payload = {
      ...valid,
      targets: [{ materialId: uuid, version: 2 }]
    };
    expect(materialSplitSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects a target that provides neither or both of materialId/material", () => {
    expect(materialSplitSchema.safeParse({ ...valid, targets: [{}] }).success).toBe(false);
    expect(materialSplitSchema.safeParse({
      ...valid,
      targets: [{ materialId: uuid, material: validTarget.material }]
    }).success).toBe(false);
  });

  it("rejects out-of-range target ordinal, empty transfers and short reason", () => {
    expect(materialSplitSchema.safeParse({
      ...valid,
      transfers: [{ sourceBatchId: uuid, targetMaterialOrdinal: 2, quantity: "1", unit: "g" }]
    }).success).toBe(false);
    expect(materialSplitSchema.safeParse({ ...valid, transfers: [] }).success).toBe(false);
    expect(materialSplitSchema.safeParse({ ...valid, reason: "x" }).success).toBe(false);
  });

  it("rejects non-positive or malformed quantities and incompatible unit enums", () => {
    const badQuantity = { ...valid, transfers: [{ ...valid.transfers[0], quantity: "0" }] };
    expect(materialSplitSchema.safeParse(badQuantity).success).toBe(false);
    const badPrecision = { ...valid, transfers: [{ ...valid.transfers[0], quantity: "1.0000001" }] };
    expect(materialSplitSchema.safeParse(badPrecision).success).toBe(false);
    const badUnit = { ...valid, transfers: [{ ...valid.transfers[0], unit: "tonne" }] };
    expect(materialSplitSchema.safeParse(badUnit).success).toBe(false);
  });
});

describe("material merge schema", () => {
  const valid = {
    targetMaterialId: uuid,
    version: 1,
    reason: "供应商规格合并",
    sources: [{ materialId: otherUuid, version: 4 }]
  };

  it("accepts a valid merge", () => {
    expect(materialMergeSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects the target appearing among sources", () => {
    expect(materialMergeSchema.safeParse({
      ...valid,
      sources: [{ materialId: uuid, version: 1 }]
    }).success).toBe(false);
  });

  it("rejects duplicate sources and an empty source list", () => {
    expect(materialMergeSchema.safeParse({
      ...valid,
      sources: [{ materialId: otherUuid, version: 1 }, { materialId: otherUuid, version: 2 }]
    }).success).toBe(false);
    expect(materialMergeSchema.safeParse({ ...valid, sources: [] }).success).toBe(false);
  });
});

describe("material archive schema", () => {
  it("requires a positive integer version", () => {
    expect(materialArchiveSchema.safeParse({ version: 1 }).success).toBe(true);
    expect(materialArchiveSchema.safeParse({}).success).toBe(false);
    expect(materialArchiveSchema.safeParse({ version: 0 }).success).toBe(false);
  });
});
