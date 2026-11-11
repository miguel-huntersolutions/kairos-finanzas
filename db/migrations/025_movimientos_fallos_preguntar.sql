ALTER TABLE movimientos
  ADD COLUMN IF NOT EXISTS ultimo_error text,
  ADD COLUMN IF NOT EXISTS intentos_preguntar integer NOT NULL DEFAULT 0
