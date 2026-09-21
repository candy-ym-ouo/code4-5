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
| GET | `/materials/:id/lineage` | 规格拆分/合并谱系时间线 |
| POST | `/materials/:id/split` | 规格拆分为新材料 |
| POST | `/materials/merge` | 规格合并到已有材料 |
| POST | `/materials/:id/archive` | 归档（请求体需携带 `version`） |

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

## 5. 规格拆分与合并

材料档案支持把一个规格拆成新档案，或把若干同单位族的规格合并到一个已有档案。
两类操作都在单个事务中完成，谱系事件只追加、不修改、不删除，逐批保留单位换算前后的数量映射。

不变量：

- 只能在同一单位族内操作（如 `g ↔ kg`、`ml ↔ l`），不同单位族拒绝。
- 同单位迁移：批次直接改挂材料，历史库存流水原样保留，不新增流水。
- 跨单位迁移：旧批次写一条 `TRANSFER_OUT` 流水（余额清零并归档，流水不可变），
  在目标材料下建立承接批次，按目标单位写一条 `TRANSFER_IN` 开账流水，换算依据落库到 `material_event_batches`。
- 合并时来源材料的项目需求会改挂到目标材料，计划数量同步换算。
- 拆分/合并携带来源（和目标）材料的 `version`，版本不匹配返回 `409 VERSION_CONFLICT`，拒绝覆盖。
- 批次全部迁走后默认自动归档来源材料（`archiveSourceWhenEmpty`）。
- 已归档材料不能拆分、合并、新增批次或被项目需求引用；数据库约束触发器兜底。
- 跨单位迁移不允许选择零余额批次（无法为承接批次开正账）。

拆分 `POST /materials/:id/split`：

```json
{
  "version": 3,
  "reason": "线轴规格改为按 m 独立管理",
  "batchIds": ["uuid"],
  "archiveSourceWhenEmpty": true,
  "newMaterial": {
    "name": "苏木线轴",
    "craftTypes": ["DYEING"],
    "stockUnit": "m",
    "code": null,
    "subtype": null,
    "lowStockThreshold": null,
    "tags": []
  }
}
```

合并 `POST /materials/merge`：

```json
{
  "version": 2,
  "targetVersion": 5,
  "reason": "确认两种染材为同一规格",
  "sourceMaterialIds": ["uuid-a"],
  "targetMaterialId": "uuid-b",
  "archiveSourceWhenEmpty": true
}
```

`GET /materials/:id/lineage` 返回该材料参与的全部事件，每个事件含来源/目标材料快照，
以及每个批次的 `action`（`MOVED`/`CONVERTED`）、`fromQuantity/fromUnit`、`toQuantity/toUnit` 和新旧批次链接。

## 6. 批次与库存

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

## 7. 项目与需求

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

## 8. 消耗与撤销

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

## 9. 颜色变化

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

## 10. 附件和导出

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
