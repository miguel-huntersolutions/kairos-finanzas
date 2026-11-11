ALTER TABLE recordatorios_pendientes
  DROP CONSTRAINT IF EXISTS recordatorios_pendientes_paso_check,
  ADD CONSTRAINT recordatorios_pendientes_paso_check CHECK (paso IN ('leer_estado', 'marcar', 'avisar', 'esperando_recibo'))
