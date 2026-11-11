CREATE INDEX IF NOT EXISTS movimientos_reembolso_pendiente_idx ON movimientos (fecha) WHERE reembolsable AND reembolso_id IS NULL
