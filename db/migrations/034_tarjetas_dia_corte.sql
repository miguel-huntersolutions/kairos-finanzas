ALTER TABLE tarjetas ADD COLUMN IF NOT EXISTS dia_corte integer CHECK (dia_corte BETWEEN 1 AND 31)
