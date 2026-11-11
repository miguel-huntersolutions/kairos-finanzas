ALTER TABLE movimientos
  DROP CONSTRAINT IF EXISTS movimientos_estado_check,
  ADD CONSTRAINT movimientos_estado_check CHECK (estado IN (
    'requiere_interpretacion', 'provisional', 'requiere_revision', 'requiere_trm', 'por_preguntar',
    'en_proceso', 'esperando_respuesta', 'confirmado', 'descartado'))
