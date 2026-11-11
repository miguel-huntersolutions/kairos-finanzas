CREATE TABLE IF NOT EXISTS revisiones_captura_lineas (
  revision_id integer NOT NULL REFERENCES revisiones_captura(id) ON DELETE CASCADE,
  n integer NOT NULL CHECK (n >= 1),
  numero integer CHECK (numero >= 1),
  fecha date,
  descripcion text,
  valor bigint,
  moneda text,
  cuotas integer,
  estado_app text CHECK (estado_app IN ('en_proceso', 'verificado')),
  resultado text NOT NULL CHECK (resultado IN ('ya_cargada', 'falta', 'dudosa', 'ignorada', 'revision', 'cargada')),
  movimiento_id uuid REFERENCES movimientos(id) ON DELETE SET NULL,
  tarjeta_id text REFERENCES tarjetas(id),
  categoria_id integer REFERENCES categorias(id),
  categoria_origen text CHECK (categoria_origen IN ('regla', 'historial', 'semilla', 'palabras', 'correccion')),
  motivo text,
  PRIMARY KEY (revision_id, n),
  UNIQUE (revision_id, numero)
)
