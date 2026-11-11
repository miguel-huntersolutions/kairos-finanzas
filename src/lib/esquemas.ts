// Esquemas estrictos de las herramientas. Los usa el MCP (para orientar al
// modelo) y las funciones del servidor (barrera real: se repite la validación).
import { z } from 'zod';

const uuid = z.string().uuid();
const persona = z.enum(['miguel', 'katerine']);
const remitente = z.enum(['miguel', 'katerine']);
const codigo = z.string().regex(/^#?[A-Z0-9]{2,4}$/i);
/** Texto libre con el que la persona se refiere a una compra: "la de 147.750", "Farmatodo", "la última". */
const referencia = z.string().min(1).max(200);
/** Número de WhatsApp de quien escribe (lo entrega el canal); el servidor lo traduce a miguel | katerine. */
const numero = z.string().regex(/^\+?[0-9 ()-]{7,20}$/);
/** Código de una revisión de captura: «R10», «#R12» (dos o más dígitos). */
const codigoRevision = z.string().regex(/^#?R\d{2,6}$/i);
/** Tarjeta como la dice la persona: «VISA», «la Mastercard», «*1111». */
const tarjetaTexto = z.string().min(1).max(60);
/** Tope de un gasto registrado por chat (pesos). Por encima se pide confirmación. */
export const MAX_VALOR_GASTO = 20_000_000;
/** Tope de un ingreso registrado por chat (pesos). */
export const MAX_VALOR_INGRESO = 200_000_000;

/** Tipos de archivo que acepta `revisar_captura` (el servidor además revisa los primeros bytes). */
export const MIMES_CAPTURA = [
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv',
] as const;

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Medio de pago como lo dice la persona: «efectivo», «PSE», «débito Bancolombia», «NU Kate». */
const medioTexto = z.string().min(1).max(60);
/** Campos de un gasto contado por chat (registrar_gasto y cada elemento de registrar_gastos). */
const GASTO = {
  valor: z.number().int().min(1).max(MAX_VALOR_GASTO),
  descripcion: z.string().trim().min(1).max(60),
  medio: medioTexto.optional(),
  medio_pago: z.enum(['efectivo', 'pse', 'bre_b', 'transferencia', 'tarjeta_debito', 'otro']).optional(),
  /** Nombre anterior de `medio` (se acepta mientras el MCP viejo siga en uso). */
  tarjeta: tarjetaTexto.optional(),
  fecha: fecha.optional(),
  categoria: z.string().min(1).max(120).optional(),
  categoria_id: z.number().int().positive().optional(),
  persona: persona.optional(),
  reembolsable: z.boolean().optional(),
  nota: z.string().max(200).optional(),
};

export const ESQUEMAS = {
  tomar_movimiento: z.object({ movimiento_id: uuid }).strict(),
  // SEC-006: `texto` se acepta por compatibilidad pero se IGNORA: el servidor arma la pregunta
  // ("¿De qué fue…?" con 2–3 categorías numeradas). El modelo no redacta mensajes a las personas.
  preguntar: z.object({ movimiento_id: uuid, texto: z.string().max(300).optional() }).strict(),
  confirmar_envio: z
    .object({ movimiento_id: uuid, pregunta_codigo: codigo, whatsapp_message_id: z.string().min(1).max(200) })
    .strict(),
  // Sin texto: el servidor arma el recordatorio con la pregunta original. `texto` se ignora.
  recordar: z.object({ movimiento_id: uuid, texto: z.string().min(1).max(300).optional() }).strict(),
  confirmar_recordatorio: z
    .object({ movimiento_id: uuid, pregunta_codigo: codigo, whatsapp_message_id: z.string().min(1).max(200) })
    .strict(),
  // «¿Qué me falta por responder?»: compras que esperan respuesta de quien escribe (y las del grupo).
  pendientes: z.object({ numero_remitente: numero.optional(), remitente: remitente.optional() }).strict(),
  resolver_respuesta: z
    .object({
      texto: z.string().min(1).max(2000),
      remitente: remitente.optional(),
      numero_remitente: numero.optional(),
      canal: z.enum(['grupo', 'privado']),
      reply_to: z.string().min(1).max(200).optional(),
      movimiento_codigo: codigo.optional(),
    })
    .strict(),
  reasignar_pregunta: z.object({ movimiento_id: uuid.optional(), referencia: referencia.optional(), persona_destino: persona }).strict(),
  // Sin movimiento_id: el servidor resuelve `referencia` (o la única compra esperando respuesta).
  // Sin categoria_id: `categoria` acepta el número de la lista, el nombre o texto libre.
  // Sin persona: quien respondió (en tarjetas individuales manda la dueña de la tarjeta).
  clasificar: z
    .object({
      movimiento_id: uuid.optional(),
      referencia: referencia.optional(),
      categoria_id: z.number().int().positive().optional(),
      categoria: z.string().min(1).max(120).optional(),
      persona: persona.optional(),
      reembolsable: z.boolean().optional(),
      nota: z.string().max(200).optional(),
      respondido_por: remitente.optional(),
      numero_remitente: numero.optional(),
      canal: z.enum(['grupo', 'privado']),
      solo_esta_vez: z.boolean().optional(),
    })
    .strict(),
  cambiar_cuotas: z
    .object({ movimiento_id: uuid.optional(), referencia: referencia.optional(), cuotas: z.number().int().min(1).max(48) })
    .strict(),
  descartar_movimiento: z
    .object({
      movimiento_id: uuid.optional(),
      referencia: referencia.optional(),
      motivo: z.enum(['rechazada', 'reversada', 'duplicada', 'no_reconocida', 'otro']),
      detalle: z.string().max(200).optional(),
      instruido_por: remitente.optional(),
      numero_remitente: numero.optional(),
    })
    .strict(),
  proponer_regla: z
    .object({
      comercio_id: z.number().int().positive(),
      categoria_id: z.number().int().positive(),
      persona: persona.optional(),
      reembolsable: z.boolean().optional(),
    })
    .strict(),
  // Sin aprobación, pero con validación de similitud: si hay parecidas, no se crea y se devuelven.
  crear_categoria: z
    .object({ nombre: z.string().trim().min(3).max(40), numero_remitente: numero, confirmar_nueva: z.boolean().optional() })
    .strict(),
  reclasificar: z
    .object({ dry_run: z.boolean(), token_confirmacion: z.string().min(10).max(80).optional(), aprobado_por: remitente.optional() })
    .strict(),
  resumen: z
    .object({
      mes: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
      persona: persona.optional(),
      tarjeta: z.string().max(60).optional(),
      categoria_id: z.number().int().positive().optional(),
      reembolsable: z.boolean().optional(),
    })
    .strict(),
  repaso: z.object({}).strict(),
  confirmar_repaso: z
    .object({
      confirmado_por: remitente,
      categorias_ids: z.array(z.number().int().positive()).max(50).optional(),
      reglas_ids: z.array(z.number().int().positive()).max(50).optional(),
    })
    .strict(),
  modo_preguntas: z.object({ modo: z.enum(['por_comercio', 'siempre']) }).strict(),
  // «Pásame el detalle / el mensaje original»: el servidor arma el texto y el MCP lo envía.
  enviar_detalle: z
    .object({ movimiento_id: uuid.optional(), referencia: referencia.optional(), numero_remitente: numero, canal: z.enum(['grupo', 'privado']) })
    .strict(),
  // Turno automático del corte: el servidor arma el aviso y decide el destino; el MCP lo envía.
  aviso_corte: z.object({ tarjeta_id: z.string().regex(/^[a-z0-9-]{2,40}$/) }).strict(),
  // Captura o reporte de la app del banco. Esta es la entrada del SERVIDOR: el MCP lee el
  // archivo (ver ESQUEMA_MCP_REVISAR_CAPTURA) y lo manda en base64; el modelo nunca lo ve.
  revisar_captura: z
    .object({
      archivo_nombre: z.string().min(1).max(200),
      mime: z.enum(MIMES_CAPTURA),
      contenido_base64: z.string().min(4).max(4_500_000),
      numero_remitente: numero,
      canal: z.enum(['grupo', 'privado']),
      tarjeta: tarjetaTexto.optional(),
    })
    .strict(),
  // Tras un «sí» explícito: carga las que faltan de la revisión (todas, o `numeros`), con
  // correcciones por número («la 2 es salud», «la 3 es de la Mastercard») o una tarjeta para todas.
  cargar_faltantes: z
    .object({
      codigo: codigoRevision,
      numeros: z.array(z.number().int().min(1).max(300)).min(1).max(300).optional(),
      correcciones: z
        .array(z.object({ n: z.number().int().min(1).max(300), categoria: z.string().min(1).max(120).optional(), tarjeta: tarjetaTexto.optional() }).strict())
        .max(50)
        .optional(),
      tarjeta: tarjetaTexto.optional(),
      numero_remitente: numero,
    })
    .strict(),
  // Gasto que la persona cuenta por chat. `medio` = con qué pagó, como lo dijo ("efectivo", "PSE",
  // "débito Bancolombia", "NU Kate"); `medio_pago` = cómo, si lo dijo (transferencia, Bre-B…).
  // Solo gastos: pagos de tarjeta, retiros, ahorros o movimientos entre cuentas se rechazan.
  registrar_gasto: z.object({ numero_remitente: numero, canal: z.enum(['grupo', 'privado']), ...GASTO }).strict(),
  // Varios gastos de un mismo mensaje: una llamada y una respuesta.
  registrar_gastos: z
    .object({
      numero_remitente: numero,
      canal: z.enum(['grupo', 'privado']),
      gastos: z.array(z.object(GASTO).strict()).min(1).max(15),
    })
    .strict(),
  // Corregir una compra ya registrada: fecha, valor, descripción, medio de pago, categoría, persona o nota.
  editar_movimiento: z
    .object({
      numero_remitente: numero,
      canal: z.enum(['grupo', 'privado']),
      movimiento_id: uuid.optional(),
      referencia: referencia.optional(),
      fecha: fecha.optional(),
      valor: z.number().int().min(1).max(MAX_VALOR_GASTO).optional(),
      descripcion: z.string().trim().min(2).max(60).optional(),
      medio: medioTexto.optional(),
      categoria: z.string().min(1).max(120).optional(),
      categoria_id: z.number().int().positive().optional(),
      persona: persona.optional(),
      nota: z.string().max(200).optional(),
    })
    .strict(),
  // Ingreso contado por chat: salario, reembolso de la empresa u otro. `persona` = quien lo recibió
  // (por defecto quien escribe). Sin `tipo`, el servidor lo deduce o pide las opciones.
  registrar_ingreso: z
    .object({
      numero_remitente: numero,
      canal: z.enum(['grupo', 'privado']),
      valor: z.number().int().min(1).max(MAX_VALOR_INGRESO),
      descripcion: z.string().trim().min(1).max(60),
      tipo: z.enum(['salario', 'reembolso', 'otro']).optional(),
      fecha: fecha.optional(),
      persona: persona.optional(),
      nota: z.string().max(200).optional(),
    })
    .strict(),
  // «Cubre la 1 y la 3»: asocia compras reembolsables pendientes (números de la lista) al último reembolso.
  asociar_reembolso: z.object({ numero_remitente: numero, numeros: z.array(z.number().int().min(1).max(300)).min(1).max(100) }).strict(),
  // «¿Cuánto nos debe la empresa?»
  reembolsos: z.object({}).strict(),
  // Deshacer un ingreso mal registrado (`referencia`: descripción, valor o «el último»).
  descartar_ingreso: z.object({ numero_remitente: numero, referencia: referencia }).strict(),
} as const;

/**
 * Lo que ve el MODELO en `revisar_captura`: solo la ruta del adjunto (como la muestra el
 * mensaje «[media attached: /root/.openclaw/media/inbound/… (image/jpeg) | …]»). El MCP lee el
 * archivo con sus guardas y arma la entrada del servidor.
 */
export const ESQUEMA_MCP_REVISAR_CAPTURA = z
  .object({
    archivo: z.string().min(1).max(500),
    numero_remitente: numero,
    canal: z.enum(['grupo', 'privado']),
    tarjeta: tarjetaTexto.optional(),
  })
  .strict();

export type Herramienta = keyof typeof ESQUEMAS;
export type Entrada<H extends Herramienta> = z.infer<(typeof ESQUEMAS)[H]>;

/** Contexto que acompaña cada llamada (trazabilidad en bitácora). */
export const CONTEXTO = z
  .object({ modelo: z.string().max(80).optional(), sesion_openclaw: z.string().max(120).optional() })
  .strict();
export type Contexto = z.infer<typeof CONTEXTO>;
