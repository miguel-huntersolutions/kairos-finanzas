CREATE UNIQUE INDEX IF NOT EXISTS movimientos_codigo_abierto_idx ON movimientos (pregunta_codigo)
  WHERE estado IN ('en_proceso', 'esperando_respuesta')
