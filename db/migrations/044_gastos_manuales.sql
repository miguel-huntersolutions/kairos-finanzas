ALTER TABLE movimientos
  ADD COLUMN IF NOT EXISTS medio_pago text CHECK (medio_pago IN ('efectivo', 'pse', 'bre_b', 'transferencia', 'tarjeta_debito', 'otro'));
