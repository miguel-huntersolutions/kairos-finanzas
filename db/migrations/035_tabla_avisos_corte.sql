CREATE TABLE IF NOT EXISTS avisos_corte (
  tarjeta_id text NOT NULL REFERENCES tarjetas(id),
  mes text NOT NULL CHECK (mes ~ '^[0-9]{4}-[0-9]{2}$'),
  estado text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'enviado', 'fallido')),
  intentos integer NOT NULL DEFAULT 0,
  creado_en timestamptz NOT NULL DEFAULT now(),
  enviado_en timestamptz,
  PRIMARY KEY (tarjeta_id, mes)
)
