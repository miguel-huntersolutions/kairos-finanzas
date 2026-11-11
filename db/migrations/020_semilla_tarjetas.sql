INSERT INTO tarjetas (id, nombre, banco, clase, tipo, persona_default) VALUES
  ('visa-bancolombia', 'VISA', 'por confirmar', 'credito', 'compartida', NULL),
  ('mastercard-bancolombia', 'Mastercard', 'por confirmar', 'credito', 'compartida', NULL),
  ('davibank', 'DaviBank', 'por confirmar', 'credito', 'compartida', NULL),
  ('plata-pay-miguel', 'Plata Pay Miguel', 'Plata Pay', 'debito', 'individual', 'miguel'),
  ('plata-pay-katerine', 'Plata Pay Katerine', 'Plata Pay', 'debito', 'individual', 'katerine'),
  ('bancolombia-debito', 'Bancolombia débito', 'Bancolombia', 'debito', 'compartida', NULL)
ON CONFLICT (id) DO NOTHING
