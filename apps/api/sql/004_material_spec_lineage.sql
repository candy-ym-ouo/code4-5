-- 材料规格拆分与合并：只追加的规格谱系。
-- 历史批次、项目需求与消耗记录不重新归属，始终可以追溯到原档案与原单位。

ALTER TYPE movement_type ADD VALUE 'SPEC_TRANSFER_OUT';

CREATE TYPE material_spec_event_type AS ENUM ('SPLIT', 'MERGE');
CREATE TYPE material_spec_role AS ENUM ('SOURCE', 'TARGET');

CREATE TABLE material_spec_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type material_spec_event_type NOT NULL,
  reason varchar(500) NOT NULL,
  idempotency_key varchar(100),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX material_spec_events_idempotency_uq ON material_spec_events(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX material_spec_events_created_idx ON material_spec_events(created_at DESC);

CREATE TABLE material_spec_event_materials (
  event_id uuid NOT NULL REFERENCES material_spec_events(id),
  material_id uuid NOT NULL REFERENCES materials(id),
  role material_spec_role NOT NULL,
  ordinal int NOT NULL CHECK (ordinal >= 0),
  version_before integer NOT NULL,
  name_snapshot varchar(120) NOT NULL,
  code_snapshot varchar(64),
  stock_unit_snapshot stock_unit NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, material_id)
);
CREATE INDEX material_spec_event_materials_material_idx ON material_spec_event_materials(material_id, event_id);

CREATE TABLE material_spec_batch_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES material_spec_events(id),
  ordinal int NOT NULL CHECK (ordinal >= 0),
  source_batch_id uuid NOT NULL REFERENCES batches(id),
  target_batch_id uuid NOT NULL REFERENCES batches(id),
  source_material_id uuid NOT NULL REFERENCES materials(id),
  target_material_id uuid NOT NULL REFERENCES materials(id),
  source_quantity numeric(18,6) NOT NULL CHECK (source_quantity > 0),
  target_quantity numeric(18,6) NOT NULL CHECK (target_quantity > 0),
  source_unit stock_unit NOT NULL,
  target_unit stock_unit NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX material_spec_transfers_event_idx ON material_spec_batch_transfers(event_id, ordinal);
CREATE INDEX material_spec_transfers_source_batch_idx ON material_spec_batch_transfers(source_batch_id);
CREATE INDEX material_spec_transfers_target_batch_idx ON material_spec_batch_transfers(target_batch_id);
CREATE INDEX material_spec_transfers_source_material_idx ON material_spec_batch_transfers(source_material_id);
CREATE INDEX material_spec_transfers_target_material_idx ON material_spec_batch_transfers(target_material_id);
