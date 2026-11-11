INSERT INTO origenes_pago (id, nombre, registro_chat, orden) VALUES
  ('credito', 'Crédito', false, 1),
  ('debito', 'Débito', true, 2),
  ('efectivo', 'Efectivo', true, 3)
ON CONFLICT (id) DO NOTHING
