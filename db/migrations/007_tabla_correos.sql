CREATE TABLE IF NOT EXISTS correos (
  correo_id text PRIMARY KEY,
  remitente text NOT NULL DEFAULT '',
  asunto text NOT NULL DEFAULT '',
  fecha_correo timestamptz NOT NULL DEFAULT now(),
  banco text,
  tipo text CHECK (tipo IN ('compra', 'reverso', 'rechazo', 'otro')),
  resultado_parser text CHECK (resultado_parser IN ('ok', 'fallo')),
  fuente_interpretacion text CHECK (fuente_interpretacion IN ('regex', 'llm_cuarentena')),
  intentos_extractor integer NOT NULL DEFAULT 0,
  estado text NOT NULL DEFAULT 'recibido'
    CHECK (estado IN ('recibido', 'procesado', 'sin_pareja', 'ignorado', 'requiere_revision')),
  texto text NOT NULL DEFAULT '',
  error text,
  recibido_en timestamptz NOT NULL DEFAULT now()
)
