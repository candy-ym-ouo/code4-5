-- 材料规格拆分与合并：谱系事件、单位映射、库存转移流水

-- 新增两种库存流水类型：
-- TRANSFER_OUT：批次在规格拆分/合并中从旧材料转出（余额清零）
-- TRANSFER_IN： 跨单位迁移产生的新批次的开账流水
ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'TRANSFER_OUT';
ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'TRANSFER_IN';

CREATE TYPE material_event_type AS ENUM ('SPLIT', 'MERGE');
CREATE TYPE material_event_batch_action AS ENUM ('KEPT', 'MOVED', 'CONVERTED', 'CREATED');

-- 材料谱系事件：一次拆分（一个来源材料 -> 一个新规格材料）
-- 或一次合并（若干来源材料 -> 一个目标材料，目标可为现有或新建材料）。
-- 事件行本身只追加、永不更新、永不删除，保证规格变更可追溯。
CREATE TABLE material_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type material_event_type NOT NULL,
  reason text,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX material_events_created_idx ON material_events(created_at DESC);

-- 事件中每个参与材料的角色快照。
-- target_order 仅在合并事件有多个目标时使用（当前合并仅一个目标，保留以备扩展）。
CREATE TABLE material_event_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES material_events(id),
  material_id uuid NOT NULL REFERENCES materials(id),
  role varchar(16) NOT NULL CHECK (role IN ('SOURCE', 'TARGET')),
  material_name varchar(120) NOT NULL,
  material_code varchar(64),
  stock_unit stock_unit NOT NULL,
  target_order integer
);
CREATE INDEX material_event_materials_event_idx ON material_event_materials(event_id);
CREATE INDEX material_event_materials_material_idx ON material_event_materials(material_id);

-- 事件涉及的批次处理明细，含跨单位映射，逐批保留转换前后数量与单位。
-- 单位映射规则同时可由 contracts 的 unitFamilies 复算，这里落库留存历史事实。
CREATE TABLE material_event_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES material_events(id),
  source_batch_id uuid REFERENCES batches(id),
  target_batch_id uuid REFERENCES batches(id),
  source_material_id uuid REFERENCES materials(id),
  target_material_id uuid REFERENCES materials(id),
  action material_event_batch_action NOT NULL,
  -- 转换前（来源批次，单位为来源材料库存单位）
  from_quantity numeric(18,6) NOT NULL CHECK (from_quantity >= 0),
  from_unit stock_unit NOT NULL,
  -- 转换后（目标批次，单位为目标材料库存单位）；同单位直接转移时与 from_* 相同
  to_quantity numeric(18,6) NOT NULL CHECK (to_quantity >= 0),
  to_unit stock_unit NOT NULL,
  seq integer NOT NULL DEFAULT 0
);
CREATE INDEX material_event_batches_event_idx ON material_event_batches(event_id);
CREATE INDEX material_event_batches_source_batch_idx ON material_event_batches(source_batch_id);
CREATE INDEX material_event_batches_target_batch_idx ON material_event_batches(target_batch_id);
CREATE INDEX material_event_batches_source_material_idx ON material_event_batches(source_material_id);
CREATE INDEX material_event_batches_target_material_idx ON material_event_batches(target_material_id);

-- 归档后禁止新增引用：
-- 已归档材料不能新增批次，也不能被项目需求引用。
-- 应用层已逐一拦截，这里以数据库约束兜底，任何写入路径都无法绕过。
CREATE OR REPLACE FUNCTION assert_material_referencable() RETURNS trigger AS $$
DECLARE
  target_archived timestamptz;
BEGIN
  SELECT archived_at INTO target_archived FROM materials WHERE id = NEW.material_id;
  IF target_archived IS NOT NULL THEN
    RAISE EXCEPTION 'material % is archived and cannot receive new references', NEW.material_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'material_archived_no_new_reference';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER batches_ref_archived_material_chk
  AFTER INSERT OR UPDATE OF material_id ON batches
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION assert_material_referencable();

CREATE CONSTRAINT TRIGGER requirements_ref_archived_material_chk
  AFTER INSERT OR UPDATE OF material_id ON project_requirements
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION assert_material_referencable();
