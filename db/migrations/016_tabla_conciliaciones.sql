CREATE TABLE IF NOT EXISTS conciliaciones (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  extracto_id text NOT NULL,
  linea integer NOT NULL,
  fecha date,
  descripcion text,
  valor bigint,
  cuota integer,
  movimiento_id uuid REFERENCES movimientos(id),
  resultado text CHECK (resultado IN ('emparejado', 'faltante', 'sobrante')),
  criterio text,
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (extracto_id, linea)
)
