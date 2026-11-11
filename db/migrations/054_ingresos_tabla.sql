CREATE TABLE IF NOT EXISTS ingresos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fecha date NOT NULL,
  valor bigint NOT NULL CHECK (valor > 0),
  descripcion text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('salario', 'reembolso', 'otro')),
  persona text NOT NULL CHECK (persona IN ('miguel', 'katerine')),
  registrado_por text NOT NULL CHECK (registrado_por IN ('miguel', 'katerine')),
  estado text NOT NULL DEFAULT 'confirmado' CHECK (estado IN ('confirmado', 'descartado')),
  nota text,
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
)
