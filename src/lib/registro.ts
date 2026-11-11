// Herramienta → operación del dominio. Una ruta por herramienta.
import * as C from './captura';
import type { Db } from './db';
import * as d from './dominio';
import * as G from './gastos';
import * as I from './ingresos';
import type { Contexto, Herramienta } from './esquemas';

type Op = (db: Db, ef: d.Efectos, e: any, ctx: Contexto) => Promise<unknown>;

export const REGISTRO: Record<Herramienta, Op> = {
  tomar_movimiento: (db, _ef, e) => d.tomarMovimiento(db, e),
  preguntar: (db, _ef, e) => d.preguntar(db, e),
  confirmar_envio: (db, ef, e, c) => d.confirmarEnvio(db, ef, e, c),
  recordar: (db, _ef, e) => d.recordar(db, e),
  confirmar_recordatorio: (db, _ef, e, c) => d.confirmarRecordatorio(db, e, c),
  pendientes: (db, _ef, e) => d.pendientes(db, e),
  resolver_respuesta: (db, _ef, e) => d.resolverRespuesta(db, e),
  reasignar_pregunta: (db, _ef, e, c) => d.reasignarPregunta(db, e, c),
  clasificar: (db, _ef, e, c) => d.clasificar(db, e, c),
  cambiar_cuotas: (db, _ef, e, c) => d.cambiarCuotas(db, e, c),
  descartar_movimiento: (db, ef, e, c) => d.descartarMovimiento(db, ef, e, c),
  proponer_regla: (db, _ef, e, c) => d.proponerRegla(db, e, c),
  crear_categoria: (db, _ef, e, c) => d.crearCategoriaChat(db, e, c),
  reclasificar: (db, _ef, e, c) => d.reclasificar(db, e, c),
  resumen: (db, ef, e) => d.resumen(db, e, ef),
  repaso: (db) => d.repaso(db),
  confirmar_repaso: (db, _ef, e, c) => d.confirmarRepaso(db, e, c),
  modo_preguntas: (db, _ef, e, c) => d.modoPreguntas(db, e, c),
  aviso_corte: (db, _ef, e) => d.avisoCorte(db, e),
  enviar_detalle: (db, _ef, e) => d.enviarDetalle(db, e),
  revisar_captura: (db, ef, e, c) => C.revisarCaptura(db, ef, e, c),
  cargar_faltantes: (db, ef, e, c) => C.cargarFaltantes(db, ef, e, c),
  registrar_gasto: (db, ef, e, c) => G.registrarGasto(db, ef, e, c),
  registrar_gastos: (db, ef, e, c) => G.registrarGastos(db, ef, e, c),
  editar_movimiento: (db, ef, e, c) => G.editarMovimientoChat(db, ef, e, c),
  registrar_ingreso: (db, ef, e, c) => I.registrarIngreso(db, ef, e, c),
  asociar_reembolso: (db, ef, e, c) => I.asociarReembolso(db, ef, e, c),
  reembolsos: (db) => I.reembolsos(db),
  descartar_ingreso: (db, ef, e, c) => I.descartarIngreso(db, ef, e, c),
};
