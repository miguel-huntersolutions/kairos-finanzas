ALTER TABLE movimientos
  ADD COLUMN IF NOT EXISTS extracto_id uuid REFERENCES extractos(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS no_aparece_en_extracto uuid REFERENCES extractos(id) ON DELETE SET NULL
