CREATE INDEX IF NOT EXISTS movimientos_no_aparece_idx ON movimientos (no_aparece_en_extracto)
  WHERE no_aparece_en_extracto IS NOT NULL
