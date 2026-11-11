INSERT INTO comercios_genericos (patron) VALUES
  ('MERCADO PAGO'), ('PAYU'), ('WOMPI'), ('BOLD'), ('NEQUI'), ('DAVIPLATA'),
  ('AMAZON'), ('DLOCAL'), ('PSE')
ON CONFLICT (patron) DO NOTHING
