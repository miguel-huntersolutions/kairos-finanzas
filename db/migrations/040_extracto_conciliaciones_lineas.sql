ALTER TABLE conciliaciones
  ADD COLUMN IF NOT EXISTS movimiento_correo_id uuid REFERENCES movimientos(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cuotas_total integer,
  DROP CONSTRAINT IF EXISTS conciliaciones_resultado_check,
  ADD CONSTRAINT conciliaciones_resultado_check CHECK (resultado IN ('emparejado', 'faltante', 'sobrante', 'revision'))
