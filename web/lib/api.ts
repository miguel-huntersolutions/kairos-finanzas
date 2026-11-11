'use client';
// Llamadas a la función `tablero`, servida en este mismo origen bajo /api/tablero.
// La sesión va en una cookie HttpOnly que el navegador envía solo; esta página
// nunca ve tokens ni el código.
export const MODO_DEMO = process.env.NEXT_PUBLIC_TABLERO_DEMO === '1' && process.env.NODE_ENV !== 'production';

const BASE = '/api/tablero';

async function llamar(metodo: 'GET' | 'POST', ruta: string, cuerpo?: unknown) {
  const r = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: cuerpo === undefined ? undefined : { 'content-type': 'application/json' },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json } as { status: number; json: any };
}

export const sesionActual = () => llamar('GET', '/sesion');
export const ingresar = (correo: string, codigo: string) => llamar('POST', '/login', { correo, codigo });
export const salir = () => llamar('POST', '/logout');
// Datos del mes (vista anterior; la API /datos se conserva).
export const datosDelMes = (mes: string) => llamar('GET', `/datos?mes=${encodeURIComponent(mes)}`);

// Tablero unificado (todas las tarjetas y fuentes)
export const datosExplorador = () => llamar('GET', '/explorador/datos');
export const reclasificar = (pedido: unknown) => llamar('POST', '/explorador/reclasificar', pedido);
// Extracto de tarjeta (PDF en base64): lo lee, guarda y concilia la función `tablero`.
export const cargarExtracto = (pdfBase64: string) => llamar('POST', '/extracto', { pdf: pdfBase64 });
// Envío sin confirmar: «sí llegó» o «volver a preguntar».
export const resolverEnvio = (movimiento_id: string, accion: 'si_llego' | 'volver_a_preguntar') => llamar('POST', '/envio', { movimiento_id, accion });
// Categoría nueva (nace activa). Si se parece a una existente no se crea y devuelve las parecidas;
// con confirmar_nueva se crea igual.
export const crearCategoria = (nombre: string, confirmar_nueva = false) => llamar('POST', '/categorias', { nombre, confirmar_nueva });
// Medios de pago y orígenes (crédito, débito, efectivo…).
export const datosMedios = () => llamar('GET', '/medios');
export const guardarOrigen = (origen: Record<string, unknown>) => llamar('POST', '/medios/origen', origen);
export const guardarMedio = (medio: Record<string, unknown>) => llamar('POST', '/medios/medio', medio);
// Detalle de una compra con el mensaje original del banco.
export const detalle = (id: string) => llamar('GET', `/detalle?id=${encodeURIComponent(id)}`);
// Cambiar la fecha de una compra.
export const cambiarFecha = (movimiento_id: string, fecha: string) => llamar('POST', '/fecha', { movimiento_id, fecha });
// Editar los datos de una compra (valor, fecha, comercio, tarjeta, categoría, persona, nota).
export const editarMovimiento = (movimiento_id: string, cambios: Record<string, unknown>) => llamar('POST', '/editar', { movimiento_id, ...cambios });
// Confirmar una compra pendiente con su categoría (misma regla que la respuesta por WhatsApp).
export const confirmar = (movimiento_id: string, categoria_id: number) => llamar('POST', '/confirmar', { movimiento_id, categoria_id });
// Compra en revisión: completar datos o descartar.
export const revision = (datos: Record<string, unknown>) => llamar('POST', '/revision', datos);

// Borrar una compra (irreversible). Exige confirmar: true; las conciliadas no se borran.
export const borrarMovimiento = (movimiento_id: string) => llamar('POST', '/borrar', { movimiento_id, confirmar: true });

// Categorías: cambiar el nombre (si se parece a otra pide confirmar) y borrar (solo sin registros).
export const renombrarCategoria = (id: number, nombre: string, confirmar_parecida = false) => llamar('POST', '/categorias/renombrar', { id, nombre, confirmar_parecida });
export const borrarCategoria = (id: number) => llamar('POST', '/categorias/borrar', { id, confirmar: true });
