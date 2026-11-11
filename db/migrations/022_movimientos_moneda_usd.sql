ALTER TABLE movimientos
  ADD COLUMN IF NOT EXISTS moneda text NOT NULL DEFAULT 'COP' CHECK (moneda IN ('COP', 'USD')),
  ADD COLUMN IF NOT EXISTS valor_original numeric CHECK (valor_original > 0),
  ADD COLUMN IF NOT EXISTS trm numeric CHECK (trm > 0),
  ADD COLUMN IF NOT EXISTS trm_fecha date
