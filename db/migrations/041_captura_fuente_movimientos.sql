ALTER TABLE movimientos
  DROP CONSTRAINT IF EXISTS movimientos_fuente_check,
  ADD CONSTRAINT movimientos_fuente_check CHECK (fuente IN ('correo', 'extracto', 'manual', 'captura'))
