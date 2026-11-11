ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS reembolso_id uuid REFERENCES ingresos(id)
