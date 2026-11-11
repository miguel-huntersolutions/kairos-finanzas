-- Semilla. Va después de esquema.sql (ver scripts/partir-migraciones.mjs).
--
-- Fuentes:
--  * Categorías: las 11 de datos.json (repo privado explorador-visa, clave
--    `categorias`) más "Reembolsable empresa". NO se usan las 16 de la app anterior.
--  * Tarjetas: 6, según Miguel. Últimos 4 en NULL (él los llena en el entorno).
--  * Comercios: COMERCIOS_SEMILLA de lib/categorize.ts (app-financial-services-home),
--    con categoría asignada. Los genéricos (pasarelas) quedan sin categoría.
--  * Los movimientos de datos.json son datos reales: NO van aquí ni en fixtures.
--
-- PENDIENTE DE CONFIRMAR POR MIGUEL (ver README):
--  * Banco de VISA, Mastercard y DaviBank ('por confirmar').
--  * Tipo de Mastercard y DaviBank (crédito, provisional).
--  * Últimos 4 de todas las tarjetas.

-- @@ semilla_categorias
INSERT INTO categorias (id, nombre, nombre_normalizado, estado) VALUES
  (1, 'Supermercado y mercado', 'supermercado y mercado', 'activa'),
  (2, 'Restaurantes y domicilios', 'restaurante y domicilio', 'activa'),
  (3, 'Transporte y viajes', 'transporte y viaje', 'activa'),
  (4, 'Servicios y telefonía', 'servicio y telefonia', 'activa'),
  (5, 'Salud y bienestar', 'salud y bienestar', 'activa'),
  (6, 'Suscripciones digitales', 'suscripcion digital', 'activa'),
  (7, 'Entretenimiento', 'entretenimiento', 'activa'),
  (8, 'Hogar y tecnología', 'hogar y tecnologia', 'activa'),
  (9, 'Ropa y compras personales', 'ropa y compra personal', 'activa'),
  (10, 'Vehículo', 'vehiculo', 'activa'),
  (11, 'Otros / pagos a comercios', 'otro y pago a comercio', 'activa'),
  (12, 'Reembolsable empresa', 'reembolsable empresa', 'activa')
ON CONFLICT (id) DO NOTHING

-- @@ semilla_tarjetas
-- ultimos_4 NULL: los llena Miguel. Banco y tipo provisionales marcados arriba.
INSERT INTO tarjetas (id, nombre, banco, clase, tipo, persona_default) VALUES
  ('visa-bancolombia', 'VISA', 'por confirmar', 'credito', 'compartida', NULL),
  ('mastercard-bancolombia', 'Mastercard', 'por confirmar', 'credito', 'compartida', NULL),
  ('davibank', 'DaviBank', 'por confirmar', 'credito', 'compartida', NULL),
  ('plata-pay-miguel', 'Plata Pay Miguel', 'Plata Pay', 'debito', 'individual', 'miguel'),
  ('plata-pay-katerine', 'Plata Pay Katerine', 'Plata Pay', 'debito', 'individual', 'katerine'),
  ('bancolombia-debito', 'Bancolombia débito', 'Bancolombia', 'debito', 'compartida', NULL)
ON CONFLICT (id) DO NOTHING

-- @@ semilla_comercios
INSERT INTO comercios (nombre, patrones, categoria_semilla_id, verificado) VALUES
  ('Uber', ARRAY['UBER RIDES', 'UBER *TRIP', 'PAYU UBER'], 3, true),
  ('Uber One', ARRAY['UBER *ONE'], 6, true),
  ('Flypass (peajes)', ARRAY['FLYPASS'], 3, true),
  ('Tienda D1', ARRAY['TIENDA D1'], 1, true),
  ('Carulla', ARRAY['CARULLA'], 1, true),
  ('Éxito', ARRAY['EXITO'], 1, true),
  ('Ara', ARRAY['TIENDAS ARA'], 1, true),
  ('PriceSmart', ARRAY['PRICESMART'], 1, true),
  ('Supermu', ARRAY['SUPERMU'], 1, true),
  ('Fruttivos', ARRAY['FRUTTIVOS'], 1, true),
  ('Dollarcity', ARRAY['DOLLARCITY'], 8, true),
  ('Miniso', ARRAY['MINISO'], 8, true),
  ('Homecenter', ARRAY['HOMECENTER'], 8, true),
  ('IKEA', ARRAY['IKEA'], 8, true),
  ('Frisby', ARRAY['FRISBY'], 2, true),
  ('Tostao', ARRAY['TOSTAO'], 2, true),
  ('Juan Valdez', ARRAY['JUAN VALDEZ', 'TIENDA DE CAFE JU VALD'], 2, true),
  ('Parmessano', ARRAY['PARMESSANO'], 2, true),
  ('Percimon', ARRAY['PERCIMON'], 2, true),
  ('Panadería Chipre', ARRAY['PANADERIA CHIPRE'], 2, true),
  ('Droguerías', ARRAY['DROG', 'DROGUERIA'], 5, true),
  ('Farmatodo', ARRAY['FARMATODO'], 5, true),
  ('EPM', ARRAY['EPM SERVICIOS'], 4, true),
  ('Claro', ARRAY['CLARO MOVIL', 'COMCEL'], 4, true),
  ('Somos Internet', ARRAY['SOMOS INTERNET'], 4, true),
  ('Suramericana', ARRAY['SURAMERICANA'], 11, true),
  ('EMI', ARRAY['EMI_ANTIOQUIA'], 5, true),
  ('Cine Colombia', ARRAY['CINE COLOMBIA'], 7, true),
  ('Netflix', ARRAY['NETFLIX', 'DLO*NETFLIX'], 6, true),
  ('Spotify', ARRAY['SPOTIFY'], 6, true),
  ('MUBI', ARRAY['MUBI'], 6, true),
  ('Apple (apps)', ARRAY['APPLE.COM/BILL'], 6, true),
  ('Apple Store', ARRAY['APPLE STORE'], NULL, true),
  ('Google', ARRAY['GOOGLE', 'DLO*GOOGLE'], NULL, true),
  ('Anthropic', ARRAY['ANTHROPIC'], 6, true),
  ('OpenAI', ARRAY['OPENAI'], 6, true),
  ('Vercel', ARRAY['VERCEL'], 6, true),
  ('Firecrawl', ARRAY['FIRECRAWL'], 6, true),
  ('dLocal', ARRAY['DLOCAL'], NULL, true),
  ('LifeMiles', ARRAY['LIFEMILES', 'SUSCRIPCILIFEMILES'], 3, true),
  ('Avianca', ARRAY['AVIANCA'], 3, true),
  ('Mercado Pago', ARRAY['MERCADO PAGO', 'MERCADOPAGO'], NULL, true),
  ('Wompi', ARRAY['WOMPI'], NULL, true),
  ('Amazon', ARRAY['AMAZON'], NULL, true),
  ('Costco', ARRAY['COSTCO'], 1, true)
ON CONFLICT (nombre) DO NOTHING
