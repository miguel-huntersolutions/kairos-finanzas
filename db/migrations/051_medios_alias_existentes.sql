UPDATE tarjetas SET
  alias = CASE id
    WHEN 'bancolombia-debito' THEN '{"debito bancolombia","bancolombia debito","cuenta bancolombia"}'::text[]
    WHEN 'visa-bancolombia' THEN '{"visa bancolombia",visa}'::text[]
    WHEN 'mastercard-bancolombia' THEN '{mastercard,master}'::text[]
    WHEN 'plata-pay-miguel' THEN '{"plata pay miguel"}'::text[]
    WHEN 'plata-pay-katerine' THEN '{"plata pay katerine","plata pay kate"}'::text[]
    ELSE alias END,
  banco = CASE WHEN id = 'visa-bancolombia' AND banco = 'por confirmar' THEN 'Bancolombia' ELSE banco END
WHERE alias = '{}'
