INSERT INTO config (clave, valor) VALUES
  ('modo_preguntas', '"por_comercio"'),
  ('umbral_reclasificacion', '5'),
  ('destino_grupo', 'null'),
  ('destino_miguel', 'null'),
  ('destino_katerine', 'null')
ON CONFLICT (clave) DO NOTHING
