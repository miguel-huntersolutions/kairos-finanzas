INSERT INTO tarjetas (id, nombre, banco, clase, tipo, persona_default, alias, canal) VALUES
  ('efectivo', 'Efectivo', NULL, 'efectivo', 'compartida', NULL, '{efectivo,"en efectivo",cash}', 'efectivo'),
  ('pse', 'PSE', NULL, 'debito', 'compartida', NULL, '{pse}', 'pse'),
  ('nu-katerine', 'NU Katerine', 'Nu', 'debito', 'individual', 'katerine', '{"nu kate","nu katerine","la nu",nu}', 'tarjeta')
ON CONFLICT (id) DO NOTHING
