ALTER TABLE movimientos
  ADD COLUMN IF NOT EXISTS conciliado_con uuid REFERENCES movimientos(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS conciliado_en timestamptz
