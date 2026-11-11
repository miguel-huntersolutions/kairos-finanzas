ALTER TABLE tarjetas
  ALTER COLUMN banco DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS alias text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS canal text NOT NULL DEFAULT 'tarjeta' CHECK (canal IN ('tarjeta', 'efectivo', 'pse', 'bre_b', 'transferencia', 'otro')),
  ADD COLUMN IF NOT EXISTS orden integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS creado_en timestamptz NOT NULL DEFAULT now()
