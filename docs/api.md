# API 文档

## 1. 基础约定

- 基础路径：`/api/v1`
- 请求与响应：JSON，附件上传除外。
- 数量：十进制字符串，例如 `"500.000000"`。
- 时间：ISO 8601，推荐包含时区偏移。
- 会话：HttpOnly Cookie `handcraft_session`。
- 分页：`page`、`pageSize`，最大 100。
- 幂等：批次入库、库存调整和材料消耗支持 `Idempotency-Key`。
- 乐观锁：更新请求携带 `version`。

成功响应：

```json
{ "data": {}, "meta": {} }
```

错误响应：

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "批次剩余数量不足",
    "fieldErrors": {},
    "requestId": "..."
  }
}
```

## 2. 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/setup/status` | 查询是否完成初始化 |
| POST | `/setup` | 创建唯一操作员 |
| POST | `/auth/login` | 登录 |
| POST | `/auth/logout` | 退出 |
| GET | `/auth/me` | 当前操作员 |
| POST | `/auth/password` | 修改密码 |

初始化请求：

```json
{
  "displayName": "工作室操作员",
  "password": "至少10位密码"
}
```

## 3. 来源与位置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/sources` | 查询或创建来源 |
| GET/PATCH | `/sources/:id` | 详情或更新 |
| POST | `/sources/:id/archive` | 归档 |
| POST | `/sources/:id/unarchive` | 取消归档 |
| GET/POST | `/locations` | 查询或创建位置 |
| PATCH | `/locations/:id` | 更新位置 |
| POST | `/locations/:id/archive` | 归档位置 |

## 4. 材料

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/materials` | 聚合库存查询或创建 |
| GET/PATCH | `/materials/:id` | 详情或更新 |
| GET | `/materials/:id/batches` | 材料批次 |
| GET | `/materials/:id/lineage` | 规格拆分/合并谱系 |
| POST | `/materials/:id/split` | 规格拆分 |
| POST | `/materials/merge` | 规格合并 |
| POST | `/materials/:id/archive` | 归档（需 `version`） |

材料列表查询参数：

- `q`
- `craftType`
- `sourceId`
- `locationId`
- `batchCode`
- `color`
- `stockState=in_stock|low_stock|out_of_stock`
- `expiryBefore`
- `tag`
- `sort`

创建材料：

```json
{
  "code": "DYE-SUMU",
  "name": "苏木染材",
  "craftTypes": ["DYEING"],
  "subtype": "天然染料",
  "stockUnit": "g",
  "lowStockThreshold": "200",
  "defaultColorName": "原木棕",
  "defaultColorHex": "#8B5A2B",
  "tags": ["天然", "染布"]
}
```

### 4.1 规格拆分与合并

规格变更不改动历史批次、项目需求和消耗记录的归属，而是通过只追加的谱系事件把库存从来源批次转到目标材料的新批次，保证历史批次与单位映射始终可追溯。

- 拆分 `POST /materials/:id/split`：把来源材料一个或多个批次的部分或全部库存转到一个或多个目标材料；目标可以是已存在材料（携带其 `version`）或在同一事务中新建。未转完的库存留在原档案，全部转出后来源材料自动归档。
- 合并 `POST /materials/merge`：把多个来源材料的全部在库批次整批转入一个既有目标材料；来源单位必须与目标单位属于同一度量族（如 g/kg、ml/l），按定点十进制自动换算，来源材料转出后自动归档。
- 谱系 `GET /materials/:id/lineage`：返回该材料参与过的全部事件、当事材料的名称/编码/单位快照以及逐批次的数量与单位映射。批次详情中的 `specTransfers` 提供双向跳转。

来源批次记 `SPEC_TRANSFER_OUT` 流水，目标批次首条流水为引用同一事件的 `OPENING`；库存总量守恒。所有被修改的材料都按 `version` 做乐观并发控制，冲突返回 `409 VERSION_CONFLICT`。两个接口都支持 `Idempotency-Key`。

拆分请求：

```json
{
  "version": 1,
  "reason": "供应商改为预磨细粉，档案拆分",
  "targets": [
    { "materialId": "uuid", "version": 1 },
    { "material": { "name": "苏木粗颗粒", "craftTypes": ["DYEING"], "stockUnit": "g" } }
  ],
  "transfers": [
    { "sourceBatchId": "uuid", "targetMaterialOrdinal": 0, "quantity": "1.5", "unit": "kg" },
    { "sourceBatchId": "uuid", "targetMaterialOrdinal": 1, "quantity": "500", "unit": "g" }
  ]
}
```

合并请求：

```json
{
  "targetMaterialId": "uuid",
  "version": 1,
  "reason": "两个供应商档案合并",
  "sources": [
    { "materialId": "uuid-a", "version": 2 },
    { "materialId": "uuid-b", "version": 1 }
  ]
}
```

主要错误：`409 VERSION_CONFLICT`（材料已被并发修改）、`409 INSUFFICIENT_STOCK`（转出超过批次结余）、`409 NO_STOCK_TO_MERGE`（来源没有在库批次）、`422 UNIT_INCOMPATIBLE`（单位不属于同一度量族）、`422 QUANTITY_PRECISION_EXCEEDED`（换算后超过 6 位小数）、`409 MATERIAL_ARCHIVED`（归档材料不能参与规格事件）。

归档请求体携带当前版本，归档后的材料不能再新增批次、项目需求、消耗、颜色变化或规格事件：

```json
{ "version": 3 }
```

## 5. 批次与库存

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/batches` | 批次查询或入库 |
| GET/PATCH | `/batches/:id` | 详情或非库存字段更新 |
| GET | `/batches/:id/movements` | 库存流水 |
| POST | `/batches/:id/adjustments` | 库存调整 |
| POST | `/batches/:id/archive` | 归档无余额批次 |

创建批次：

```json
{
  "materialId": "uuid",
  "batchCode": "B-20260913-01",
  "sourceId": "uuid",
  "receivedAt": "2026-09-13",
  "initialQuantity": "1",
  "entryUnit": "kg",
  "totalCost": "120.00",
  "currency": "CNY"
}
```

库存调整：

```json
{
  "direction": "OUT",
  "quantity": "30",
  "unit": "g",
  "reason": "盘点发现包装破损",
  "version": 1
}
```

同一 `Idempotency-Key` 重试不会重复调整。

## 6. 项目与需求

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/projects` | 查询或创建项目 |
| GET/PATCH | `/projects/:id` | 详情或更新 |
| POST | `/projects/:id/status` | 更新状态 |
| POST | `/projects/:id/archive` | 归档 |
| POST | `/projects/:id/requirements` | 添加材料需求 |
| PATCH | `/projects/:id/requirements/:requirementId` | 更新需求 |
| DELETE | `/projects/:id/requirements/:requirementId` | 删除未使用需求 |

材料需求：

```json
{
  "materialId": "uuid",
  "requiredQuantity": "0.5",
  "unit": "kg",
  "purpose": "染液"
}
```

## 7. 消耗与撤销

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/consumptions` | 查询或创建消耗 |
| GET | `/consumptions/:id` | 消耗详情 |
| POST | `/consumptions/:id/reverse` | 撤销 |

首次为计划中的项目创建消耗时，项目会自动转为 `IN_PROGRESS` 并记录审计日志。

创建消耗：

```json
{
  "projectId": "uuid",
  "projectRequirementId": "uuid",
  "batchId": "uuid",
  "usedQuantity": "450",
  "wasteQuantity": "50",
  "unit": "g",
  "consumedAt": "2026-09-13T10:00:00+08:00",
  "purpose": "染液"
}
```

撤销：

```json
{
  "reason": "录入批次错误"
}
```

## 8. 颜色变化

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/color-changes` | 查询或记录 |
| GET/PATCH | `/color-changes/:id` | 详情或更新备注 |
| DELETE | `/color-changes/:id` | 删除最新误录记录 |

颜色变化：

```json
{
  "batchId": "uuid",
  "projectId": "uuid",
  "changeType": "DYE_BATH",
  "afterColorName": "深红棕",
  "afterColorHex": "#6B2F1F",
  "affectedQuantity": "450",
  "unit": "g",
  "occurredAt": "2026-09-13T10:05:00+08:00",
  "phValue": 5.5
}
```

颜色变化不扣库存。

## 9. 附件和导出

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/attachments` | multipart 上传 |
| GET | `/attachments/:id` | 受保护下载 |
| DELETE | `/attachments/:id` | 删除 |
| GET | `/exports/materials.csv` | 材料 CSV |
| GET | `/exports/batches.csv` | 批次 CSV |
| GET | `/exports/workspace.json` | 完整 JSON |
| GET | `/audit-logs` | 审计日志 |
| GET | `/dashboard` | 仪表盘 |

附件表单字段：

- `ownerType`：`BATCH`、`COLOR_CHANGE`、`PROJECT` 或 `CONSUMPTION`
- `ownerId`
- `file`

支持 JPEG、PNG、WebP，默认最大 10 MB。
