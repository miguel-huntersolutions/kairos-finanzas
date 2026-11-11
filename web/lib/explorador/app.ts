// @ts-nocheck — port casi literal del script del explorador-visa (DOM + d3).
// Tablero unificado: todas las tarjetas y fuentes, con filtro de tarjeta y de estado,
// columna "Estado" y banda "Por atender". Los posibles duplicados de extracto se ven en
// Movimientos pero no suman (./calculos).
// Cambios frente al original: datos en vivo desde /api/tablero/explorador/datos;
// reclasificar persiste en la base (sin localStorage ni exportar/importar); intereses y
// deuda salen del último extracto cargado («Cargar extracto»), sin refinanciación; crear
// categorías: botón «Nueva categoría». Los KPIs salen de ./calculos (probados).
import * as d3 from 'd3';
import { OTROS, cuentaEnTotales, filtrar, kpisMes, kpisReclasificar, kpisResumen, suma, topComercios } from './calculos';

export interface ApiExplorador {
  datos: () => Promise<{ status: number; json: any }>;
  reclasificar: (pedido: unknown) => Promise<{ status: number; json: any }>;
  sinSesion: () => void;
  /** POST /extracto con el PDF en base64 (sin él, el botón no se muestra). */
  cargarExtracto?: (pdfBase64: string) => Promise<{ status: number; json: any }>;
  /** POST /envio: decide un envío sin confirmar. */
  resolverEnvio?: (movimiento_id: string, accion: 'si_llego' | 'volver_a_preguntar') => Promise<{ status: number; json: any }>;
  /** POST /categorias: categoría nueva. */
  crearCategoria?: (nombre: string, confirmar_nueva?: boolean) => Promise<{ status: number; json: any }>;
  /** GET /detalle: compra con su mensaje original. */
  detalle?: (id: string) => Promise<{ status: number; json: any }>;
  /** POST /fecha: cambia la fecha de una compra. */
  cambiarFecha?: (movimiento_id: string, fecha: string) => Promise<{ status: number; json: any }>;
  /** POST /editar: cambia los datos de una compra (solo los campos indicados). */
  editar?: (movimiento_id: string, cambios: Record<string, unknown>) => Promise<{ status: number; json: any }>;
  /** POST /categorias/renombrar: cambia el nombre de una categoría (pide confirmar si se parece a otra). */
  renombrarCategoria?: (id: number, nombre: string, confirmar_parecida?: boolean) => Promise<{ status: number; json: any }>;
  /** POST /categorias/borrar: borra una categoría sin registros asociados. */
  borrarCategoria?: (id: number) => Promise<{ status: number; json: any }>;
  /** POST /borrar: borra una compra (irreversible). */
  borrar?: (movimiento_id: string) => Promise<{ status: number; json: any }>;
  /** POST /confirmar: confirma una compra pendiente con su categoría. */
  confirmar?: (movimiento_id: string, categoria_id: number) => Promise<{ status: number; json: any }>;
  /** POST /revision: completar o descartar una compra en revisión. */
  revision?: (datos: Record<string, unknown>) => Promise<{ status: number; json: any }>;
}

export function montarExplorador(api: ApiExplorador): () => void {
  const PALETTE = ['#2f6f9f','#d08a2c','#3f9a6b','#c4534a','#7b62b8','#2a9fa8','#b5679a','#8c7a3e','#5f7f95','#d9a63a','#8f99a3','#4c8f4a','#a15c3a','#6a7fd0'];
  const COP = v => '$' + Math.round(v).toLocaleString('es-CO');
  const M = v => '$' + (v/1e6).toLocaleString('es-CO',{minimumFractionDigits:1,maximumFractionDigits:1}) + ' M';
  const Mn = v => (v/1e6).toLocaleString('es-CO',{minimumFractionDigits:1,maximumFractionDigits:1});
  const PCT = v => (v*100).toLocaleString('es-CO',{maximumFractionDigits:0}) + ' %';
  const el = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const [k,v] of Object.entries(attrs)) { if (v == null || v === false) continue; if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v); } for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c)); return n; };
  const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };
  const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^A-Za-z0-9_.-]+/g,'_').replace(/^[._]+|[._]+$/g,'').slice(0,120) + '-' + hash(s);

  const S = { extracto:null, data:null, tab:'resumen', f:{mes:'',cat:'',monto:'',q:'',tarjeta:'',estado:''}, cmp:null, rcCat:OTROS, open:new Set(), sort:{k:'fecha',d:-1}, limit:200, guardando:false, mesInicial:false };
  let colorOf = () => '#888';
  let vivo = true;

  // ---------- data & persistence ----------
  const effCat = m => m.categoria;
  const catId = nombre => (S.data.categorias.find(c => c.nombre === nombre) || {}).id;
  const catNombre = id => (S.data.categorias.find(c => c.id === id) || {}).nombre || 'Sin clasificar';
  const allCats = () => { const set = new Set(S.data.categorias.map(c => c.nombre)); S.data.movimientos.forEach(m => set.add(m.categoria)); const arr = [...set].filter(c => c !== OTROS); arr.push(OTROS); return arr; };
  const refreshColors = () => { const cats = allCats(); const map = new Map(cats.map((c,i) => [c, c === OTROS ? '#9aa3ad' : PALETTE[i % PALETTE.length]])); colorOf = c => map.get(c) || '#888'; };
  const $ = id => document.getElementById(id);
  const setSave = (cls, text) => { const s = $('saveState'); if (!s) return; s.className = 'save-state ' + cls; $('saveText').textContent = text; };

  /** Envía un cambio a la base y aplica la respuesta. Devuelve los cambios (para deshacer). */
  async function guardar(pedido) {
    if (S.guardando) { toast('Espera a que termine el cambio anterior.'); return null; }
    S.guardando = true; setSave('local', 'Guardando…');
    try {
      const r = await api.reclasificar(pedido);
      if (r.status === 401) { api.sinSesion(); return null; }
      if (r.status !== 200) { setSave('local', 'No se guardó: ' + (r.json.error || 'error')); toast('No se pudo guardar el cambio.'); return null; }
      const porId = new Map(r.json.cambios.map(c => [c.movimiento_id, c]));
      S.data.movimientos.forEach(m => { const c = porId.get(m.id); if (c) { m.categoria_id = c.despues; m.categoria = catNombre(c.despues); } });
      setSave('ok', r.json.actualizados ? 'Guardado en la base' : 'Sin cambios');
      if (r.json.regla && r.json.regla.regla) S.reglaAviso = r.json.regla.motivo === 'regla propuesta' || r.json.regla.motivo === 'regla reiniciada en propuesta'
        ? ' · regla propuesta para las próximas compras (se confirma con la siguiente respuesta igual o en el repaso)' : '';
      return r.json.cambios;
    } catch (e) { setSave('local', 'Sin conexión: el cambio no se guardó'); toast('Sin conexión: el cambio no se guardó.'); return null; }
    finally { S.guardando = false; if (vivo) render(); }
  }
  const deshacer = cambios => guardar({ cambios: cambios.filter(c => c.antes != null).map(c => ({ movimiento_id: c.movimiento_id, categoria_id: c.antes })) });
  async function writeRegla(comercio, categoria, etiquetaToast) {
    const cambios = await guardar(Object.assign({ comercio, categoria_id: catId(categoria) }, S.f.tarjeta ? { tarjeta_id: S.f.tarjeta } : {}));
    if (cambios && cambios.length) toast((etiquetaToast || (comercio + ' → ' + categoria + ' (' + cambios.length + ' compras)')) + (S.reglaAviso || ''), () => deshacer(cambios));
    S.reglaAviso = '';
  }
  async function writeAjuste(m, categoria) {
    const cambios = await guardar({ movimiento_id: m.id, categoria_id: catId(categoria) });
    if (cambios && cambios.length) toast('Compra de ' + COP(m.valor) + ' → ' + categoria, () => deshacer(cambios));
  }
  async function restaurar(grupo) {
    const cambios = grupo.filter(m => m.categoria !== m.categoria_inicial && catId(m.categoria_inicial)).map(m => ({ movimiento_id: m.id, categoria_id: catId(m.categoria_inicial) }));
    if (!cambios.length) return;
    const hechos = await guardar({ cambios });
    if (hechos && hechos.length) toast(grupo[0].comercio + ': categorías restauradas', () => deshacer(hechos));
  }

  let toastTimer;
  function toast(text, undo) {
    const t = $('toast'); if (!t) return; $('toastText').textContent = text;
    const b = $('toastUndo'); b.hidden = !undo; b.onclick = () => { t.hidden = true; undo && undo(); };
    t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
  }

  // ---------- filtering ----------
  const rows = (o = {}) => filtrar(S.data.movimientos, S.f, o);
  const sum = suma;
  const etiqueta = mes => (S.data.meses.find(x => x.mes === mes) || {}).etiqueta || mes;
  const cuota = m => m.cuotas > 1 ? ' · ' + m.cuotas + ' cuotas' : '';
  const tarjetaTxt = m => m.tarjeta ? ' · ' + m.tarjeta : '';
  function estadoCelda(m) {
    const td = el('td',{}, el('span',{class:'estado ' + (m.grupo || ''), text:m.estado_vista || '—'}));
    if (m.duplicado_de) td.append(el('span',{class:'tag dup',text:'posible duplicado de extracto', title:'Misma tarjeta, mismo valor y fecha a ±3 días de una compra del extracto: no suma'}));
    else if (m.no_aparece) td.append(el('span',{class:'tag dup',text:'no aparece en el extracto', title:'La compra llegó por correo pero no está en el extracto de su corte: sigue sumando hasta que se revise'}));
    else if (m.por_conciliar) td.append(el('span',{class:'tag',text:'Por conciliar'}));
    return td;
  }
  function porAtender() {
    const p = S.data.por_atender || [];
    if (!p.length) return null;
    const ul = el('ul',{});
    p.slice(0, 20).forEach(x => {
      const li = el('li',{}, el('strong',{text:x.comercio}), ' · ' + x.valor_texto + ' · ' + x.tarjeta + ' · ' + x.fecha + ' — ', el('span',{class:'estado pendiente',text:x.estado}), el('span',{class:'desc',text:x.motivo}));
      if (x.accion === 'revision' && api.revision) li.append(' ', el('button',{type:'button', class:'btn', onclick:() => abrirDetalle(x.id, true)}, 'Atender'));
      else if (x.accion === 'confirmar' && api.confirmar) li.append(' ', el('button',{type:'button', class:'btn', onclick:() => abrirDetalle(x.id, 'confirmar')}, 'Confirmar'));
      else if (/^[0-9a-f-]{36}$/.test(x.id) && api.detalle) li.append(' ', el('button',{type:'button', class:'btn ghost', onclick:() => abrirDetalle(x.id, false)}, 'Ver mensaje'));
      if (x.accion === 'envio' && api.resolverEnvio) li.append(' ',
        el('button',{type:'button', class:'btn', onclick:() => decidirEnvio(x.id, 'si_llego')}, 'Sí llegó'), ' ',
        el('button',{type:'button', class:'btn', onclick:() => decidirEnvio(x.id, 'volver_a_preguntar')}, 'Volver a preguntar'));
      ul.append(li);
    });
    if (p.length > 20) ul.append(el('li',{class:'note',text:'… y ' + (p.length - 20) + ' más'}));
    return el('section',{class:'panel atender', 'aria-labelledby':'t-atender'}, el('h2',{id:'t-atender',text:'Por atender (' + p.length + ')'}),
      el('p',{class:'note',text:'Compras esperando respuesta por WhatsApp, correos que requieren revisión (por ejemplo, tarjeta desconocida) y lo que dejó la conciliación del extracto: compras que no aparecen en él y líneas a revisar a mano.'}), ul);
  }

  // ---------- detalle y revisión ----------
  const hoy = () => new Date().toISOString().slice(0, 10);
  /** Mes actual «AAAA-MM» en hora de Bogotá (no en UTC: después de las 7 p. m. cambiaría de día). */
  const mesActual = () => {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
    return p.find(x => x.type === 'year').value + '-' + p.find(x => x.type === 'month').value;
  };
  async function abrirDetalle(id, atender) {
    const dlg = $('dlg'), cuerpo = $('dlgCuerpo');
    if (!dlg || !api.detalle) return;
    cuerpo.replaceChildren(el('p',{class:'note',text:'Cargando…'}));
    if (!dlg.open) dlg.showModal();
    let r;
    try { r = await api.detalle(id); } catch (e) { cuerpo.replaceChildren(el('p',{text:'Sin conexión.'})); return; }
    if (r.status === 401) { dlg.close(); api.sinSesion(); return; }
    if (r.status !== 200) { cuerpo.replaceChildren(el('p',{text:'No se pudo leer: ' + (r.json.error || 'error')})); return; }
    const d = r.json;
    const cerrar = el('button',{type:'button', class:'btn ghost', onclick:() => dlg.close()}, 'Cerrar');
    const filas = [['Valor', d.valor_texto], ['Fecha', d.fecha || '—'], ['Comercio', d.comercio || d.descripcion_original || '—'], ['Tarjeta', d.tarjeta || '—'],
      ['Categoría', d.categoria || '—'], ['Persona', d.persona || '—'], ['Estado', d.estado], ['Nota', d.nota || '']].filter(f => f[1]);
    const info = el('dl',{class:'dl'}, ...filas.flatMap(([k, v]) => [el('dt',{text:k}), el('dd',{text:String(v)})]));
    const msg = d.correo
      ? el('section',{}, el('h3',{text:'Mensaje original'}), el('p',{class:'note',text:(d.correo.remitente || '') + ' · ' + (d.correo.asunto || '(sin asunto)') + ' · ' + String(d.correo.fecha || '').slice(0, 16).replace('T', ' ')}), el('pre',{class:'correo',text:d.correo.texto || '(vacío)'}))
      : el('p',{class:'note',text: d.fuente === 'extracto' ? 'Viene del extracto: ' + (d.descripcion_original || '') : d.fuente === 'captura' ? 'Captura: se cargó desde una captura o reporte de la app del banco (' + (d.descripcion_original || '') + ')' : 'No hay correo original guardado.'});
    const partes = [el('div',{class:'dlg-cab'}, el('h2',{id:'dlgTitulo',text: atender === 'confirmar' ? 'Confirmar compra' : atender === 'fecha' ? 'Cambiar fecha' : atender === 'editar' ? 'Editar compra' : atender ? 'Atender compra en revisión' : 'Detalle de la compra'}), cerrar), info];
    partes.push(msg);
    if ((!atender || atender === 'editar') && api.borrar) partes.push(seccionBorrar(d, dlg));
    if (atender === 'editar' && api.editar) partes.push(formEditar(d, dlg));
    else if (atender === 'fecha' && api.cambiarFecha) partes.push(formFecha(d, dlg));
    else if (atender === 'confirmar' && api.confirmar) partes.push(formConfirmar(d, dlg));
    else if (atender && api.revision) partes.push(formRevision(d, dlg));
    cuerpo.replaceChildren(...partes);
  }
  /** Borrado definitivo: el botón solo se activa tras marcar la casilla que advierte que es irrecuperable. */
  function seccionBorrar(d, dlg) {
    const ok = el('input',{type:'checkbox', id:'borrarOk'});
    const boton = el('button',{type:'button', class:'btn danger', disabled:true}, 'Borrar definitivamente');
    const estado = el('p',{class:'note', role:'status'});
    ok.addEventListener('change', () => { boton.disabled = !ok.checked; });
    boton.addEventListener('click', async () => {
      if (!ok.checked) return;
      boton.disabled = true; estado.textContent = 'Borrando…';
      try {
        const r = await api.borrar(d.movimiento_id);
        if (r.status === 401) { dlg.close(); api.sinSesion(); return; }
        if (r.status !== 200) { estado.textContent = 'No se borró: ' + (r.json.error || 'error'); boton.disabled = !ok.checked; return; }
        dlg.close();
        toast('Compra borrada. Quedó constancia en la bitácora.');
        await cargarDatos(); if (vivo) render();
      } catch (err) { estado.textContent = 'Sin conexión: no se borró.'; boton.disabled = !ok.checked; }
    });
    return el('section',{class:'borrar', 'aria-labelledby':'tBorrar'},
      el('h3',{id:'tBorrar', text:'Borrar esta compra'}),
      el('div',{class:'aviso-irrecuperable', role:'alert'},
        el('strong',{text:'Esta acción es irrecuperable.'}),
        ' La compra desaparece de la base y de los totales, y no hay forma de deshacerla. Solo queda una copia en la bitácora. Si la compra ya está conciliada con el extracto, el servidor no la deja borrar: descártala.'),
      el('label',{class:'check-borrar', for:'borrarOk'}, ok, ' Estoy seguro de que quiero borrar esta compra'),
      el('div',{class:'row-actions'}, boton),
      estado);
  }
  /** Formulario para editar todos los datos de la compra; solo envía los campos que cambiaron. */
  function formEditar(d, dlg) {
    const tarjetas = S.data.tarjetas_todas || S.data.tarjetas || [];
    const fecha = el('input',{type:'date', required:true, min:'2020-01-01', max:hoy(), value:d.fecha || hoy()});
    const valor = el('input',{type:'number', inputmode:'numeric', min:'1', step:'1', required:true, value: d.valor != null ? String(d.valor) : ''});
    const comercio = el('input',{type:'text', minlength:'2', maxlength:'60', required:true, value: d.comercio || ''});
    const tarjeta = el('select',{'aria-label':'Tarjeta'}, el('option',{value:'', text:'Sin tarjeta', selected: !d.tarjeta_id}),
      ...tarjetas.map(t => el('option',{value:t.id, text:t.nombre, selected: t.id === d.tarjeta_id})));
    const cat = el('select',{'aria-label':'Categoría'}, el('option',{value:'', text:'Sin categoría', selected: !d.categoria_id}),
      ...S.data.categorias.map(c => el('option',{value:String(c.id), text:c.nombre, selected: c.id === d.categoria_id})));
    const persona = el('select',{'aria-label':'Persona'}, el('option',{value:'', text:'Sin persona', selected: !d.persona}),
      el('option',{value:'miguel', text:'Miguel', selected: d.persona === 'miguel'}), el('option',{value:'katerine', text:'Katerine', selected: d.persona === 'katerine'}));
    const nota = el('textarea',{maxlength:'200', rows:'2'}, d.nota || '');
    const estado = el('p',{class:'note', role:'status'});
    const campo = (texto, control) => el('label',{}, texto, control);
    return el('form',{class:'form-revision', onsubmit: async (e) => { e.preventDefault();
      const cambios = {};
      if (fecha.value && fecha.value !== d.fecha) cambios.fecha = fecha.value;
      if (valor.value && Number(valor.value) !== d.valor) cambios.valor = Number(valor.value);
      if (comercio.value.trim() && comercio.value.trim() !== (d.comercio || '')) cambios.comercio = comercio.value.trim();
      if (tarjeta.value && tarjeta.value !== d.tarjeta_id) cambios.tarjeta_id = tarjeta.value;
      if (cat.value && Number(cat.value) !== d.categoria_id) cambios.categoria_id = Number(cat.value);
      if (persona.value && persona.value !== d.persona) cambios.persona = persona.value;
      if (nota.value.trim() !== (d.nota || '')) cambios.nota = nota.value.trim();
      if (!Object.keys(cambios).length) { dlg.close(); return; }
      estado.textContent = 'Guardando…';
      try {
        const r = await api.editar(d.movimiento_id, cambios);
        if (r.status === 401) { dlg.close(); api.sinSesion(); return; }
        if (r.status !== 200) { estado.textContent = 'No se guardó: ' + (r.json.error || 'error'); return; }
        dlg.close();
        toast('Compra actualizada');
        await cargarDatos(); if (vivo) render();
      } catch (err) { estado.textContent = 'Sin conexión: no se guardó.'; }
    }},
      el('p',{class:'note',text:'Cambia lo que haga falta. Cada cambio queda en la bitácora con el valor anterior.'}),
      campo('Fecha', fecha), campo('Valor (COP)', valor), campo('Comercio', comercio), campo('Tarjeta', tarjeta),
      campo('Categoría', cat), campo('Persona', persona), campo('Nota', nota),
      el('div',{class:'row-actions'}, el('button',{type:'submit', class:'btn'}, 'Guardar cambios')),
      estado);
  }
  function formFecha(d, dlg) {
    const fecha = el('input',{type:'date', required:true, min:'2020-01-01', max:hoy(), value:d.fecha || hoy()});
    const estado = el('p',{class:'note', role:'status'});
    return el('form',{class:'form-revision', onsubmit:async (e) => { e.preventDefault();
      if (fecha.value === d.fecha) { dlg.close(); return; }
      estado.textContent = 'Guardando…';
      try {
        const r = await api.cambiarFecha(d.movimiento_id, fecha.value);
        if (r.status === 401) { dlg.close(); api.sinSesion(); return; }
        if (r.status !== 200) { estado.textContent = 'No se guardó: ' + (r.json.error || 'error'); return; }
        dlg.close();
        toast('Fecha cambiada a ' + fecha.value.slice(8) + '/' + fecha.value.slice(5, 7) + '/' + fecha.value.slice(0, 4));
        await cargarDatos(); if (vivo) render();
      } catch (err) { estado.textContent = 'Sin conexión: no se guardó.'; }
    }},
      el('p',{class:'note',text:'Fecha en que ocurrió la compra. Cambia el mes en que suma y su conciliación con el extracto.'}),
      el('label',{}, 'Fecha', fecha),
      el('div',{class:'row-actions'}, el('button',{type:'submit', class:'btn'}, 'Guardar fecha')),
      estado);
  }
  function formConfirmar(d, dlg) {
    const cat = el('select',{required:true, 'aria-label':'Categoría'}, el('option',{value:'', text:'Elegir categoría…'}), ...S.data.categorias.map(c => el('option',{value:String(c.id), text:c.nombre})));
    const estado = el('p',{class:'note', role:'status'});
    const form = el('form',{class:'form-revision', onsubmit:async (e) => { e.preventDefault();
      estado.textContent = 'Guardando…';
      try {
        const r = await api.confirmar(d.movimiento_id, Number(cat.value));
        if (r.status === 401) { dlg.close(); api.sinSesion(); return; }
        if (r.status !== 200 || r.json.aplicado === false) { estado.textContent = 'No se guardó: ' + (r.json.error || r.json.mensaje || 'error'); return; }
        dlg.close();
        toast('Compra confirmada: ' + (r.json.categoria || cat.options[cat.selectedIndex].text));
        await cargarDatos(); if (vivo) render();
      } catch (err) { estado.textContent = 'Sin conexión: no se guardó.'; }
    }},
      el('p',{class:'note',text:'Elige la categoría. Queda confirmada como si la hubieran respondido por WhatsApp.'}),
      el('label',{}, 'Categoría', cat),
      el('div',{class:'row-actions'}, el('button',{type:'submit', class:'btn'}, 'Confirmar')),
      estado);
    return form;
  }
  function formRevision(d, dlg) {
    const tarjetas = S.data.tarjetas_todas || S.data.tarjetas || [];
    const valor = el('input',{type:'number', inputmode:'numeric', min:'1', step:'1', required:true, value: d.valor_texto && /\d/.test(d.valor_texto) && !/pendiente/.test(d.valor_texto) ? d.valor_texto.replace(/\D/g, '') : ''});
    const fecha = el('input',{type:'date', required:true, value: d.fecha || hoy()});
    const tarjeta = el('select',{required:true}, el('option',{value:'', text:'Elegir…'}), ...tarjetas.map(t => el('option',{value:t.id, text:t.nombre, selected: t.nombre === d.tarjeta})));
    const comercio = el('input',{type:'text', required:true, minlength:'2', maxlength:'60', value: d.comercio || d.descripcion_original || ''});
    const cat = el('select',{}, el('option',{value:'', text:'Preguntar por WhatsApp'}), ...S.data.categorias.map(c => el('option',{value:String(c.id), text:c.nombre})));
    const motivo = el('select',{'aria-label':'Motivo del descarte'}, ...[['otro','No es una compra'],['duplicada','Duplicada'],['rechazada','Rechazada'],['reversada','Reversada'],['no_reconocida','No la reconozco']].map(([v, t]) => el('option',{value:v, text:t})));
    const estado = el('p',{class:'note', role:'status'});
    const enviar = async (datos) => {
      estado.textContent = 'Guardando…';
      try {
        const r = await api.revision(datos);
        if (r.status === 401) { dlg.close(); api.sinSesion(); return; }
        if (r.status !== 200) { estado.textContent = 'No se guardó: ' + (r.json.error || 'error'); return; }
        dlg.close();
        toast(datos.accion === 'descartar' ? 'Compra descartada.' : r.json.estado === 'confirmado' ? 'Compra completada y clasificada.' : 'Compra completada: se preguntará por WhatsApp.');
        await cargarDatos(); if (vivo) render();
      } catch (e) { estado.textContent = 'Sin conexión: no se guardó.'; }
    };
    const form = el('form',{class:'form-revision', onsubmit:(e) => { e.preventDefault();
      enviar({ accion:'completar', movimiento_id:d.movimiento_id, valor:Number(valor.value), fecha:fecha.value, tarjeta_id:tarjeta.value, comercio:comercio.value.trim(), ...(cat.value ? { categoria_id:Number(cat.value) } : {}) }); }},
      el('p',{class:'note',text:'Completa los datos con el mensaje original (arriba). Sin categoría, se pregunta por WhatsApp.'}),
      el('label',{}, 'Valor (COP)', valor), el('label',{}, 'Fecha', fecha), el('label',{}, 'Tarjeta', tarjeta), el('label',{}, 'Comercio', comercio), el('label',{}, 'Categoría', cat),
      el('div',{class:'row-actions'}, el('button',{type:'submit', class:'btn'}, 'Guardar')),
      el('div',{class:'inline descartar'}, motivo, el('button',{type:'button', class:'btn ghost', onclick:() => { if (window.confirm('¿Descartar esta compra? No sumará en los totales.')) enviar({ accion:'descartar', movimiento_id:d.movimiento_id, motivo:motivo.value }); }}, 'Descartar')),
      estado);
    return form;
  }

  async function decidirEnvio(id, accion) {
    try {
      const r = await api.resolverEnvio(id, accion);
      if (r.status === 401) { api.sinSesion(); return; }
      if (r.status !== 200) { toast('No se pudo: ' + (r.json.error || 'error')); return; }
      toast(accion === 'si_llego' ? 'Listo: queda esperando la respuesta.' : 'Listo: se vuelve a preguntar en la próxima revisión (hasta 30 min).');
      await cargarDatos(); if (vivo) render();
    } catch (e) { toast('Sin conexión: no se guardó.'); }
  }
  async function nuevaCategoria(dada) {
    const nombre = String(typeof dada === 'string' && dada.trim() ? dada : (window.prompt('Nombre de la categoría nueva (3 a 40 letras):') || '')).trim();
    if (!nombre) return;
    try {
      let r = await api.crearCategoria(nombre);
      if (r.status === 401) { api.sinSesion(); return; }
      if (r.status !== 200) { toast('No se pudo crear: ' + (r.json.error || 'error')); return; }
      if (!r.json.creada && r.json.parecidas && r.json.parecidas.length) {
        // Validación de similitud: se proponen las parecidas antes de crear la nueva.
        const lista = r.json.parecidas.map((p) => '«' + p.nombre + '»').join(', ');
        if (!window.confirm('Ya hay categorías parecidas: ' + lista + '.\n\n¿Crear «' + nombre + '» de todas formas?')) { toast('No se creó: usa ' + lista + '.'); return; }
        r = await api.crearCategoria(nombre, true);
        if (r.status !== 200) { toast('No se pudo crear: ' + (r.json.error || 'error')); return; }
      }
      if (!r.json.creada) { toast(r.json.mensaje || ('Ya existe: ' + ((r.json.existente || r.json.categoria || {}).nombre || nombre))); if (r.json.reactivada) { await cargarDatos(); if (vivo) { refreshColors(); render(); } } return; }
      toast('Categoría creada: ' + r.json.categoria.nombre);
      await cargarDatos(); if (vivo) { refreshColors(); render(); }
    } catch (e) { toast('Sin conexión: no se creó.'); }
  }

  // ---------- extracto (PDF) ----------
  // Vercel corta el cuerpo de la petición en ~4,5 MB y el base64 crece un tercio.
  const MAX_SUBIDA = 3.3 * 1024 * 1024;
  async function subirExtracto(file) {
    if (!file || !api.cargarExtracto || (S.extracto && S.extracto.cargando)) return;
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { S.extracto = {error:'Elige un archivo PDF.'}; render(); return; }
    if (file.size > MAX_SUBIDA) { S.extracto = {error:'El PDF pesa más de 3,3 MB; no se puede subir.'}; render(); return; }
    S.extracto = {cargando:true}; render();
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      const r = await api.cargarExtracto(btoa(bin));
      if (r.status === 401) { api.sinSesion(); return; }
      S.extracto = r.status === 200 ? {res:r.json} : {error:(r.json && r.json.error) || ('No se pudo cargar (error ' + r.status + ').')};
      if (r.status === 200) await cargarDatos();
    } catch (e) { S.extracto = {error:'Sin conexión: el extracto no se cargó.'}; }
    if (vivo) render();
  }
  function panelExtracto() {
    const x = S.extracto; if (!x) return null;
    const cerrar = x.cargando ? null : el('button',{type:'button', class:'btn ghost', onclick:() => { S.extracto = null; render(); }}, 'Cerrar');
    let cuerpo;
    if (x.cargando) cuerpo = el('p',{class:'note', role:'status', text:'Leyendo el extracto… puede tardar hasta un minuto.'});
    else if (x.error) cuerpo = el('p',{class:'error', role:'alert', text:x.error});
    else {
      const r = x.res; const cab = (r.tarjeta || 'Tarjeta desconocida') + (r.fecha_corte ? ' · corte ' + r.fecha_corte : '');
      const ul = el('ul',{});
      const li = t => ul.append(el('li',{text:t}));
      if (r.repetido) li('Este PDF ya se había cargado: no se volvió a procesar.');
      if (r.estado === 'en_revision') li('Quedó en revisión: ' + (r.motivo || 'algo no cuadró') + '. No se concilió nada.');
      else {
        li(r.lineas + ' líneas leídas');
        li(r.conciliadas + ' conciliadas con compras que llegaron por correo');
        li(r.creadas + ' sin correo (quedan como compras del extracto)');
        li(r.no_aparecen + ' compras por correo que no aparecen en el extracto (en «Por atender»)');
        if (r.en_revision) li(r.en_revision + ' líneas a revisar a mano (cuotas, abonos o compras en USD)');
      }
      if (r.intereses != null) li('Intereses del corte: ' + COP(r.intereses));
      if (r.saldo_total != null) li('Deuda total al corte: ' + COP(r.saldo_total));
      cuerpo = el('div',{}, el('p',{class:'note',text:cab}), ul);
    }
    return el('section',{class:'panel atender', 'aria-labelledby':'t-extracto', 'aria-live':'polite'}, el('div',{class:'inline'}, el('h2',{id:'t-extracto',text:'Extracto'}), cerrar), cuerpo);
  }
  /** Intereses y deuda del corte del mes (de la tarjeta filtrada, o de todas sumadas). */
  function kpiIntereses(mes) {
    const cs = (S.data.extractos || []).filter(e => e.mes === mes && (!S.f.tarjeta || e.tarjeta_id === S.f.tarjeta));
    if (!cs.length) return kpiCard('Intereses y deuda del corte', 'Sin extracto', 'Carga el extracto del corte para ver intereses y deuda');
    const intereses = cs.reduce((t, e) => t + (e.intereses || 0), 0);
    const deuda = cs.some(e => e.saldo_total != null) ? 'Deuda total ' + COP(cs.reduce((t, e) => t + (e.saldo_total || 0), 0)) : 'Sin deuda total en el extracto';
    const detalle = cs.length === 1 ? deuda + ' · ' + cs[0].tarjeta + ', corte ' + cs[0].fecha_corte.slice(8) + '/' + cs[0].fecha_corte.slice(5, 7) : deuda + ' · ' + cs.length + ' tarjetas';
    return kpiCard('Intereses del corte', COP(intereses), detalle);
  }

  // ---------- tooltip ----------
  const tip = $('tip');
  function showTip(ev, head, lines) {
    tip.replaceChildren(el('div',{class:'h',text:head}), ...lines.map(l => el('div',{class:'row'}, l.c ? el('i',{style:'background:'+l.c}) : null, el('span',{text:l.t}))));
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = ev.clientX + 14, y = ev.clientY + 14;
    if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
    if (y + h > innerHeight - 8) y = ev.clientY - h - 14;
    tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------- chart helpers ----------
  function svgIn(box, h) { box.replaceChildren(); const w = Math.max(300, box.clientWidth || 600); const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${w} ${h}`).attr('role','img'); return {svg, w}; }
  function textW(svg, strs, cls) { let m = 0; for (const s of strs) { const t = svg.append('text').attr('class', cls || null).text(s); m = Math.max(m, t.node().getComputedTextLength()); t.remove(); } return m; }
  function yAxis(svg, y, x0, x1, fmt) { const ticks = y.ticks(5); svg.append('g').selectAll('line').data(ticks).join('line').attr('x1',x0).attr('x2',x1).attr('y1',y).attr('y2',y).attr('stroke','var(--line)'); svg.append('g').selectAll('text').data(ticks).join('text').attr('x',x0-6).attr('y',t => y(t)+4).attr('text-anchor','end').text(fmt); }

  function monthStack(box) {
    const data = rows({ignoreMes:true}); const cats = allCats();
    const byMes = S.data.meses.map(mm => { const o = {mes:mm.mes, etiqueta:mm.etiqueta}; cats.forEach(c => o[c] = 0); data.filter(m => m.mes === mm.mes).forEach(m => o[effCat(m)] += m.valor); o.total = cats.reduce((s,c) => s + o[c], 0); return o; });
    const H = 300; const {svg, w} = svgIn(box, H);
    const y = d3.scaleLinear([0, (d3.max(byMes, d => d.total) || 1) * 1.08], [H-24, 10]).nice();
    const ml = textW(svg, y.ticks(5).map(Mn)) + 12;
    const x = d3.scaleBand(byMes.map(d => d.mes), [ml, w-4]).padding(.22);
    yAxis(svg, y, ml, w-4, Mn);
    svg.append('g').selectAll('text').data(byMes).join('text').attr('x', d => x(d.mes)+x.bandwidth()/2).attr('y', H-6).attr('text-anchor','middle').text(d => d.etiqueta);
    const series = d3.stack().keys(cats)(byMes);
    const sel = S.f.mes;
    svg.append('g').selectAll('g').data(series).join('g').attr('fill', s => colorOf(s.key))
      .selectAll('rect').data(s => s.map(p => Object.assign(p, {key:s.key}))).join('rect')
      .attr('class','clickable').attr('x', p => x(p.data.mes)).attr('width', x.bandwidth())
      .attr('y', p => y(p[1])).attr('height', p => Math.max(0, y(p[0]) - y(p[1])))
      .attr('opacity', p => sel && p.data.mes !== sel ? .35 : 1)
      .on('pointermove', (ev, p) => { const d = p.data; const top = cats.filter(c => d[c] > 0).sort((a,b) => d[b]-d[a]).slice(0,6); showTip(ev, d.etiqueta + ' · ' + COP(d.total), top.map(c => ({c:colorOf(c), t:c + ': ' + COP(d[c])}))); })
      .on('pointerleave', hideTip)
      .on('click', (ev, p) => { hideTip(); setFilter('mes', S.f.mes === p.data.mes ? '' : p.data.mes); });
    if (x.bandwidth() > 34) svg.append('g').selectAll('text').data(byMes).join('text').attr('class','lab').attr('x', d => x(d.mes)+x.bandwidth()/2).attr('y', d => y(d.total)-4).attr('text-anchor','middle').text(d => d.total ? Mn(d.total) : '');
  }

  function catBars(box, data, onClick, selected) {
    const tot = sum(data) || 1; const map = d3.rollup(data, v => sum(v), m => effCat(m));
    const items = [...map].map(([c,v]) => ({c, v})).sort((a,b) => b.v - a.v);
    if (!items.length) { box.replaceChildren(el('p',{class:'empty',text:'No hay compras con estos filtros.'})); return; }
    const rh = 28, H = items.length * rh + 6; const {svg, w} = svgIn(box, H);
    const ml = Math.min(textW(svg, items.map(d => d.c), 'lab') + 12, w * .45);
    const mr = textW(svg, items.map(d => Mn(d.v) + ' · ' + PCT(d.v/tot))) + 10;
    const x = d3.scaleLinear([0, items[0].v], [0, Math.max(30, w - ml - mr)]);
    const g = svg.selectAll('g.r').data(items).join('g').attr('class','r clickable').attr('transform', (d,i) => `translate(0,${i*rh+3})`)
      .on('click', (ev,d) => { hideTip(); onClick && onClick(d.c); })
      .on('pointermove', (ev,d) => showTip(ev, d.c, [{c:colorOf(d.c), t:COP(d.v) + ' · ' + PCT(d.v/tot)}])).on('pointerleave', hideTip);
    g.append('rect').attr('x',0).attr('y',0).attr('width',w).attr('height',rh).attr('fill','transparent');
    g.append('text').attr('class','lab').attr('x', ml-8).attr('y', rh/2+1).attr('text-anchor','end').attr('dominant-baseline','middle').text(d => d.c);
    g.append('rect').attr('x', ml).attr('y', 5).attr('height', rh-12).attr('rx', 3).attr('width', d => Math.max(1, x(d.v))).attr('fill', d => colorOf(d.c)).attr('opacity', d => selected && d.c !== selected ? .35 : 1);
    g.append('text').attr('x', d => ml + x(d.v) + 6).attr('y', rh/2+1).attr('dominant-baseline','middle').text(d => Mn(d.v) + ' · ' + PCT(d.v/tot));
  }

  // ---------- views ----------
  function kpiCard(label, value, detail, cls) { return el('div',{class:'panel kpi'}, el('span',{class:'l',text:label}), el('span',{class:'v',text:value}), detail ? el('span',{class:'d ' + (cls||''), text:detail}) : null); }

  function viewResumen(v) {
    const data = rows(); const k = kpisResumen(data);
    v.append(el('section',{class:'kpis'},
      kpiCard('Consumo', COP(k.total), S.f.mes ? 'Mes de ' + etiqueta(S.f.mes) : k.meses + ' meses · ' + M(k.porMes) + ' por mes'),
      kpiCard('Compras', k.compras.toLocaleString('es-CO'), k.compras ? 'Promedio ' + COP(k.promedio) : ''),
      kpiCard('Hormiga (≤ $20.000)', COP(k.hormiga.total), k.hormiga.compras + ' compras · ' + PCT(k.hormiga.pct) + ' del consumo'),
      kpiCard('Sin categoría clara («Otros»)', COP(k.otros.total), PCT(k.otros.pct) + ' del consumo')
    ));
    const g = el('section',{class:'grid'});
    const c1 = el('div',{class:'chart', style:'min-height:300px'});
    const lg = el('div',{class:'legend'}, allCats().map(c => el('span',{}, el('i',{style:'background:'+colorOf(c)}), c)));
    g.append(el('div',{class:'panel'}, el('h2',{text:'Consumo por mes y categoría'}), el('p',{class:'note',text:'Millones de pesos. Toca un mes para filtrarlo; tócalo de nuevo para quitarlo.'}), c1, lg));
    const c2 = el('div',{class:'chart'});
    g.append(el('div',{class:'panel'}, el('h2',{text:'En qué se va el dinero'}), el('p',{class:'note',text:'Toca una categoría para filtrar todo por ella.'}), c2));
    v.append(g);
    const tb = el('tbody');
    topComercios(data).forEach(r => tb.append(el('tr',{}, el('td',{}, r.k, el('span',{class:'desc',text:r.c})), el('td',{class:'num',text:String(r.n)}), el('td',{class:'num',text:COP(r.t)}), el('td',{class:'num hide-sm',text:COP(r.t/r.n)}))));
    v.append(el('section',{class:'panel'}, el('h2',{text:'Comercios con más gasto'}), el('p',{class:'note',text:'Con los filtros actuales.'}),
      el('div',{class:'tbl'}, el('table',{}, el('thead',{}, el('tr',{}, el('th',{text:'Comercio'}), el('th',{class:'num',text:'Compras'}), el('th',{class:'num',text:'Total'}), el('th',{class:'num hide-sm',text:'Promedio'}))), tb))));
    requestAnimationFrame(() => { monthStack(c1); catBars(c2, rows({ignoreCat:true}), c => setFilter('cat', S.f.cat === c ? '' : c), S.f.cat); });
  }

  function viewMes(v) {
    const list = S.data.meses; const mes = S.f.mes || list[list.length-1].mes;
    const idx = list.findIndex(x => x.mes === mes); const prev = idx > 0 ? list[idx-1] : null; const info = list[idx];
    const filt = rows({ignoreMes:true}); const cur = filt.filter(m => m.mes === mes); const ant = prev ? filt.filter(m => m.mes === prev.mes) : [];
    const delta = (a, b, fmt) => { if (!prev || !b) return 'Sin mes anterior'; const d = a - b; return (d >= 0 ? '+' : '−') + fmt(Math.abs(d)) + ' vs ' + prev.etiqueta + ' (' + (d>=0?'+':'−') + PCT(Math.abs(d)/b) + ')'; };
    const cls = (a, b) => !prev ? '' : a > b ? 'up' : a < b ? 'down' : '';
    const pick = el('select',{id:'mesPick','aria-label':'Mes'}); list.forEach(x => pick.append(el('option',{value:x.mes, selected:x.mes===mes, text:x.etiqueta})));
    pick.addEventListener('change', () => setFilter('mes', pick.value));
    v.append(el('div',{class:'panel'}, el('div',{class:'inline'}, el('h2',{text:'Mes de ' + info.etiqueta}), pick), el('p',{class:'note',text:'Comparado con el mes anterior (mes calendario). Rojo es más gasto; verde, menos. Los demás filtros siguen activos.'})));
    const k = kpisMes(cur, ant);
    v.append(el('section',{class:'kpis'},
      kpiCard('Consumo', COP(k.consumo.actual), delta(k.consumo.actual, k.consumo.anterior, COP), cls(k.consumo.actual, k.consumo.anterior)),
      kpiCard('Compras', String(k.compras.actual), delta(k.compras.actual, k.compras.anterior, n => String(n)), cls(k.compras.actual, k.compras.anterior)),
      kpiCard('Hormiga (≤ $20.000)', COP(k.hormiga.actual), k.hormiga.compras + ' compras · ' + delta(k.hormiga.actual, k.hormiga.anterior, COP), cls(k.hormiga.actual, k.hormiga.anterior)),
      kpiIntereses(mes)
    ));
    const g = el('section',{class:'grid'});
    const c1 = el('div',{class:'chart'});
    g.append(el('div',{class:'panel'}, el('h2',{text:'Categorías: ' + info.etiqueta + (prev ? ' frente a ' + prev.etiqueta : '')}), el('div',{class:'legend'}, el('span',{}, el('i',{style:'background:var(--accent)'}), info.etiqueta), prev ? el('span',{}, el('i',{style:'background:var(--line)'}), prev.etiqueta) : null), c1));
    const big = cur.slice().sort((a,b) => b.valor - a.valor).slice(0, 10); const tb = el('tbody');
    big.forEach(m => tb.append(el('tr',{}, el('td',{text:m.fecha.slice(8)+'/'+m.fecha.slice(5,7)}), el('td',{}, m.desc, el('span',{class:'desc',text:effCat(m) + tarjetaTxt(m)})), el('td',{class:'num',text:COP(m.valor)}))));
    g.append(el('div',{class:'panel'}, el('h2',{text:'Las 10 compras más grandes'}), cur.length ? el('div',{class:'tbl'}, el('table',{}, el('thead',{}, el('tr',{}, el('th',{text:'Fecha'}), el('th',{text:'Descripción'}), el('th',{class:'num',text:'Valor'}))), tb)) : el('p',{class:'empty',text:'No hay compras con estos filtros.'})));
    v.append(g);
    requestAnimationFrame(() => pairBars(c1, cur, ant, !!prev));
  }

  function pairBars(box, cur, ant, hasPrev) {
    const a = d3.rollup(cur, x => sum(x), effCat), b = d3.rollup(ant, x => sum(x), effCat);
    const cats = [...new Set([...a.keys(), ...b.keys()])].map(c => ({c, v:a.get(c)||0, p:b.get(c)||0})).sort((x,y) => y.v - x.v || y.p - x.p);
    if (!cats.length) { box.replaceChildren(el('p',{class:'empty',text:'No hay compras con estos filtros.'})); return; }
    const rh = 34, H = cats.length * rh + 6; const {svg, w} = svgIn(box, H);
    const ml = Math.min(textW(svg, cats.map(d => d.c), 'lab') + 12, w*.42);
    const mr = textW(svg, cats.map(d => Mn(d.v) + '  +000 %')) + 10;
    const x = d3.scaleLinear([0, d3.max(cats, d => Math.max(d.v, d.p)) || 1], [0, Math.max(30, w-ml-mr)]);
    const g = svg.selectAll('g').data(cats).join('g').attr('transform', (d,i) => `translate(0,${i*rh+3})`)
      .on('pointermove', (ev,d) => showTip(ev, d.c, [{c:'var(--accent)', t:'Este mes: ' + COP(d.v)}].concat(hasPrev ? [{c:'var(--line)', t:'Anterior: ' + COP(d.p)}] : []))).on('pointerleave', hideTip);
    g.append('rect').attr('width',w).attr('height',rh).attr('fill','transparent');
    g.append('text').attr('class','lab').attr('x', ml-8).attr('y', rh/2).attr('text-anchor','end').attr('dominant-baseline','middle').text(d => d.c);
    g.append('rect').attr('x', ml).attr('y', 6).attr('height', 11).attr('rx', 2).attr('width', d => Math.max(1, x(d.v))).attr('fill','var(--accent)');
    if (hasPrev) g.append('rect').attr('x', ml).attr('y', 19).attr('height', 7).attr('rx', 2).attr('width', d => Math.max(d.p ? 1 : 0, x(d.p))).attr('fill','var(--line)');
    g.append('text').attr('x', d => ml + x(Math.max(d.v, d.p)) + 6).attr('y', rh/2).attr('dominant-baseline','middle').each(function(d) {
      const t = d3.select(this); t.append('tspan').attr('class','lab').text(Mn(d.v));
      if (hasPrev && d.p) { const ch = (d.v - d.p)/d.p; t.append('tspan').attr('dx', 6).attr('fill', ch > 0 ? 'var(--bad)' : 'var(--good)').text((ch>0?'+':'−') + PCT(Math.abs(ch))); }
      else if (hasPrev && d.v) t.append('tspan').attr('dx', 6).text('nuevo');
    });
  }

  function viewComparar(v) {
    const data = rows({ignoreMes:true, ignoreCat:true}); const cats = allCats();
    const totals = d3.rollup(data, x => sum(x), effCat);
    if (!S.cmp) S.cmp = new Set([...totals].sort((a,b) => b[1]-a[1]).slice(0,3).map(d => d[0]));
    const chips = el('div',{class:'chips'});
    cats.forEach(c => chips.append(el('button',{type:'button', class:'chip', 'aria-pressed':String(S.cmp.has(c)), onclick:() => { if (S.cmp.has(c)) S.cmp.delete(c); else if (S.cmp.size < 6) S.cmp.add(c); else { toast('Puedes comparar hasta 6 categorías.'); return; } render(); }}, el('i',{style:'background:'+colorOf(c)}), c)));
    v.append(el('div',{class:'panel'}, el('h2',{text:'Elige las categorías a comparar'}), el('p',{class:'note',text:'Hasta 6. El filtro de mes y de categoría no aplica aquí; monto y búsqueda sí.'}), chips));
    const sel = [...S.cmp];
    const series = sel.map(c => ({c, pts:S.data.meses.map(mm => ({mes:mm.mes, etiqueta:mm.etiqueta, v:sum(data.filter(m => m.mes === mm.mes && effCat(m) === c))}))}));
    const box = el('div',{class:'chart', style:'min-height:320px'});
    v.append(el('section',{class:'panel'}, el('h2',{text:'Evolución por mes'}), el('p',{class:'note',text:'Millones de pesos. Pasa el cursor para ver los valores de cada mes.'}), box));
    const tb = el('tbody');
    series.forEach(s => { const vals = s.pts.map(p => p.v); const tot = d3.sum(vals); const prom = tot / vals.length; const mx = s.pts.reduce((a,b) => b.v > a.v ? b : a); const last = vals[vals.length-1]; const ch = prom ? (last - prom)/prom : 0;
      tb.append(el('tr',{}, el('td',{}, el('span',{style:'display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;background:'+colorOf(s.c)}), s.c), el('td',{class:'num',text:COP(tot)}), el('td',{class:'num',text:COP(prom)}), el('td',{class:'num hide-sm',text:mx.etiqueta + ' · ' + M(mx.v)}), el('td',{class:'num',text:COP(last)}), el('td',{class:'num ' + (ch>0?'up':'down'), text:(ch>=0?'+':'−') + PCT(Math.abs(ch))}))); });
    v.append(el('section',{class:'panel'}, el('h2',{text:'Resumen de la comparación'}), el('div',{class:'tbl'}, el('table',{}, el('thead',{}, el('tr',{}, el('th',{text:'Categoría'}), el('th',{class:'num',text:'Total'}), el('th',{class:'num',text:'Promedio por mes'}), el('th',{class:'num hide-sm',text:'Mes más alto'}), el('th',{class:'num',text:'Último mes'}), el('th',{class:'num',text:'Último vs promedio'}))), tb))));
    requestAnimationFrame(() => lineChart(box, series));
  }

  // ---------- categorías: renombrar y borrar ----------
  async function renombrarCat(c) {
    const dado = window.prompt('Nuevo nombre para «' + c.nombre + '» (3 a 40 letras):', c.nombre);
    if (dado == null) return;
    const nombre = dado.trim();
    if (!nombre || nombre === c.nombre) return;
    try {
      let r = await api.renombrarCategoria(c.id, nombre);
      if (r.status === 401) { api.sinSesion(); return; }
      if (r.status === 200 && r.json.aplicado === false && r.json.parecidas) {
        const lista = r.json.parecidas.map((p) => '«' + p.nombre + '»').join(', ');
        if (!window.confirm('«' + nombre + '» se parece a ' + lista + '.\n\n¿Cambiar el nombre de todas formas?')) { toast('No se cambió el nombre.'); return; }
        r = await api.renombrarCategoria(c.id, nombre, true);
      }
      if (r.status !== 200 || r.json.aplicado === false) { toast('No se pudo: ' + (r.json.error || r.json.mensaje || 'error')); return; }
      toast(r.json.sin_cambios ? 'Sin cambios.' : 'Categoría renombrada: ' + r.json.categoria.nombre);
      await cargarDatos(); if (vivo) { refreshColors(); render(); }
    } catch (e) { toast('Sin conexión: no se guardó.'); }
  }
  async function borrarCat(c) {
    if (!window.confirm('¿Borrar la categoría «' + c.nombre + '»?\n\nEsta acción es irrecuperable. No tiene registros asociados.')) return;
    try {
      const r = await api.borrarCategoria(c.id);
      if (r.status === 401) { api.sinSesion(); return; }
      if (r.status !== 200) { toast('No se pudo: ' + (r.json.error || 'error')); return; }
      toast('Categoría borrada: ' + c.nombre);
      await cargarDatos(); if (vivo) { refreshColors(); render(); }
    } catch (e) { toast('Sin conexión: no se borró.'); }
  }
  function viewCategorias(v) {
    const lista = S.data.categorias_gestion || [];
    const tb = el('tbody');
    lista.forEach(c => {
      const usos = c.compras + c.reglas + c.comercios + c.capturas;
      const motivo = c.base ? 'Categoría base: se puede renombrar, no borrar.' : usos ? 'Tiene registros asociados: reclasifícalos antes de borrarla.' : 'Borrar esta categoría (irrecuperable).';
      const detalle = usos ? [c.compras ? c.compras + (c.compras === 1 ? ' compra' : ' compras') : '', c.reglas ? c.reglas + (c.reglas === 1 ? ' regla' : ' reglas') : '', c.comercios ? c.comercios + ' de semilla' : '', c.capturas ? c.capturas + ' de capturas' : ''].filter(Boolean).join(' · ') : 'Sin registros';
      tb.append(el('tr',{},
        el('td',{}, el('span',{style:'display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;background:'+colorOf(c.nombre)}), c.nombre, c.base ? el('span',{class:'tag',text:'base'}) : null),
        el('td',{class:'hide-sm',text:detalle}),
        el('td',{}, el('div',{class:'row-actions'},
          api.renombrarCategoria ? el('button',{type:'button', class:'btn ghost mini', 'aria-label':'Cambiar el nombre de ' + c.nombre, onclick:() => renombrarCat(c)}, 'Editar nombre') : null,
          api.borrarCategoria ? el('button',{type:'button', class:'btn ghost mini', disabled: c.base || usos > 0, title:motivo, 'aria-label':'Borrar ' + c.nombre, onclick:() => borrarCat(c)}, 'Borrar') : null))));
    });
    v.append(el('section',{class:'panel'},
      el('h2',{text:'Categorías'}),
      el('p',{class:'note',text:'Cambia el nombre de una categoría (las compras siguen en ella) o bórrala si no tiene ningún registro. Una categoría con compras, reglas o capturas no se puede borrar: reclasifica esos registros primero. Las nuevas se crean con «Nueva categoría».'}),
      el('div',{class:'tbl'}, el('table',{}, el('thead',{}, el('tr',{}, el('th',{text:'Categoría'}), el('th',{class:'hide-sm',text:'Registros'}), el('th',{text:'Acciones'}))), tb))));
  }

  function lineChart(box, series) {
    if (!series.length) { box.replaceChildren(el('p',{class:'empty',text:'Elige al menos una categoría.'})); return; }
    const H = 320; const {svg, w} = svgIn(box, H); const months = S.data.meses;
    const y = d3.scaleLinear([0, (d3.max(series, s => d3.max(s.pts, p => p.v)) || 1) * 1.1], [H-24, 12]).nice();
    const ml = textW(svg, y.ticks(5).map(Mn)) + 12;
    const x = d3.scalePoint(months.map(m => m.mes), [ml + 8, w - 12]);
    yAxis(svg, y, ml, w-4, Mn);
    svg.append('g').selectAll('text').data(months).join('text').attr('x', d => x(d.mes)).attr('y', H-6).attr('text-anchor','middle').text(d => d.etiqueta);
    const line = d3.line().x(p => x(p.mes)).y(p => y(p.v));
    series.forEach(s => { svg.append('path').attr('d', line(s.pts)).attr('fill','none').attr('stroke', colorOf(s.c)).attr('stroke-width', 2).attr('stroke-linejoin','round').attr('stroke-linecap','round');
      svg.append('g').selectAll('circle').data(s.pts).join('circle').attr('cx', p => x(p.mes)).attr('cy', p => y(p.v)).attr('r', 3).attr('fill', colorOf(s.c)); });
    const rule = svg.append('line').attr('y1', 12).attr('y2', H-24).attr('stroke','var(--muted)').attr('stroke-dasharray','3 3').attr('opacity', 0);
    svg.append('rect').attr('x', ml).attr('y', 0).attr('width', w-ml).attr('height', H-24).attr('fill','transparent')
      .on('pointermove', ev => { const [px] = d3.pointer(ev); const i = d3.minIndex(months, m => Math.abs(x(m.mes) - px)); const mm = months[i]; rule.attr('x1', x(mm.mes)).attr('x2', x(mm.mes)).attr('opacity', 1);
        showTip(ev, mm.etiqueta, series.map(s => ({c:colorOf(s.c), t:s.c + ': ' + COP(s.pts[i].v)}))); })
      .on('pointerleave', () => { rule.attr('opacity', 0); hideTip(); });
  }

  function catSelect(value, onChange, id, m) {
    const bloqueada = m && m.reclasificable === false;
    const s = el('select',{'aria-label':'Categoría', id, disabled: S.guardando || bloqueada, title: bloqueada ? 'Pendiente: se clasifica respondiendo por WhatsApp' : null});
    allCats().forEach(c => s.append(el('option',{value:c, selected:c===value, text:c, disabled: !catId(c)})));
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  function viewReclasificar(v) {
    const all = S.data.movimientos.filter(cuentaEnTotales); const k = kpisReclasificar(all);
    const nNew = el('input',{type:'text', id:'newCat', placeholder:'Nueva categoría', maxlength:'40', disabled:!api.crearCategoria, 'aria-label':'Nueva categoría'});
    const addBtn = el('button',{type:'button', class:'btn', disabled:!api.crearCategoria, onclick:() => nuevaCategoria(nNew.value)}, 'Agregar categoría');
    const viewSel = el('select',{'aria-label':'Ver comercios de', id:'rcView'});
    allCats().forEach(c => viewSel.append(el('option',{value:c, selected:c===S.rcCat, text:c})));
    viewSel.addEventListener('change', () => { S.rcCat = viewSel.value; S.open.clear(); render(); });
    v.append(el('section',{class:'kpis'},
      kpiCard('«Otros» al empezar', COP(k.otrosOrig), PCT(k.pctOrig) + ' del consumo'),
      kpiCard('«Otros» ahora', COP(k.otrosNow), PCT(k.pctNow) + ' del consumo', k.otrosNow < k.otrosOrig ? 'down' : ''),
      kpiCard('Comercios reclasificados', String(k.comerciosAjustados), 'Con al menos una compra cambiada'),
      kpiCard('Compras reclasificadas', String(k.comprasAjustadas), 'Distintas de su categoría inicial')));
    v.append(el('div',{class:'panel'}, el('h2',{text:'Cómo funciona'}),
      el('p',{class:'note',text:'Cambia la categoría de un comercio y se mueven todas sus compras confirmadas (de la tarjeta elegida en el filtro, o de todas). Para comercios que mezclan cosas (MercadoPago, DLocal), abre sus compras y cambia cada una. Cada cambio se guarda en la base con quién y cuándo; «Deshacer» lo revierte. Si falta una categoría, agrégala aquí.'}),
      el('div',{class:'inline'}, el('label',{class:'inline'}, el('span',{class:'note',text:'Ver comercios de'}), viewSel), nNew, addBtn)));

    const data = rows({ignoreCat:true}).filter(m => effCat(m) === S.rcCat || (S.open.size && [...S.open].includes(m.comercio)));
    const groups = d3.rollups(data, a => a, m => m.comercio).map(([k, a]) => ({k, a, t:sum(a.filter(m => effCat(m) === S.rcCat)), n:a.filter(m => effCat(m) === S.rcCat).length})).filter(g => g.n || S.open.has(g.k)).sort((a,b) => b.t - a.t);
    const tb = el('tbody');
    if (!groups.length) tb.append(el('tr',{}, el('td',{colspan:'4', class:'empty', text:'No quedan comercios en «' + S.rcCat + '» con estos filtros.'})));
    groups.slice(0, 150).forEach(g => {
      const isOpen = S.open.has(g.k);
      const todas = S.data.movimientos.filter(m => m.comercio === g.k);
      const cambiadas = todas.filter(m => m.categoria !== m.categoria_inicial);
      const sel = catSelect(S.rcCat, c => writeRegla(g.k, c), 'r-' + slug(g.k));
      const openBtn = el('button',{type:'button', class:'btn ghost', 'aria-expanded':String(isOpen), onclick:() => { if (isOpen) S.open.delete(g.k); else S.open.add(g.k); render(); }}, isOpen ? 'Ocultar compras' : 'Ver ' + g.a.length + ' compras');
      const actions = el('div',{class:'row-actions'}, openBtn, cambiadas.length ? el('button',{type:'button', class:'btn ghost', disabled:S.guardando, onclick:() => restaurar(todas)}, 'Restaurar') : null);
      tb.append(el('tr',{}, el('td',{}, g.k, cambiadas.length ? el('span',{class:'tag',text:'reclasificado'}) : null, el('span',{class:'desc',text:g.n + ' compras en «' + S.rcCat + '»'})), el('td',{class:'num',text:COP(g.t)}), el('td',{}, sel), el('td',{}, actions)));
      if (isOpen) g.a.slice().sort((a,b) => b.fecha.localeCompare(a.fecha)).forEach(m => {
        const aj = m.categoria !== m.categoria_inicial;
        tb.append(el('tr',{class:'sub'}, el('td',{}, m.desc, aj ? el('span',{class:'tag',text:'ajustada'}) : null, el('span',{class:'desc',text:m.fecha + tarjetaTxt(m) + cuota(m)})), el('td',{class:'num',text:COP(m.valor)}),
          el('td',{}, catSelect(effCat(m), c => writeAjuste(m, c), 'a-' + m.id, m)), el('td',{})));
      });
    });
    v.append(el('section',{class:'panel'}, el('h2',{text:'Comercios en «' + S.rcCat + '»'}), el('p',{class:'note',text:'Ordenados por gasto. Respeta los filtros de mes, monto y búsqueda.'}),
      el('div',{class:'tbl'}, el('table',{}, el('thead',{}, el('tr',{}, el('th',{text:'Comercio'}), el('th',{class:'num',text:'Total'}), el('th',{text:'Categoría'}), el('th',{}))), tb))));
  }

  function viewMovimientos(v) {
    const data = rows({conDuplicados:true}); const {k, d} = S.sort;
    data.sort((a,b) => k === 'valor' ? d*(a.valor - b.valor) : k === 'cat' ? d*effCat(a).localeCompare(effCat(b)) : d*(a.fecha.localeCompare(b.fecha) || a.valor - b.valor));
    const th = (key, label, cls) => el('th',{class:'sortable ' + (cls||''), 'aria-sort': k === key ? (d > 0 ? 'ascending' : 'descending') : 'none', tabindex:'0',
      onclick:() => { S.sort = {k:key, d: k === key ? -d : (key === 'cat' ? 1 : -1)}; render(); }, onkeydown:e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}, label);
    const tb = el('tbody');
    data.slice(0, S.limit).forEach(m => { const aj = m.categoria !== m.categoria_inicial;
      const dd = m.fecha.slice(8)+'/'+m.fecha.slice(5,7);
      tb.append(el('tr',{}, el('td',{class:'num'}, api.cambiarFecha
          ? el('button',{type:'button', class:'btn ghost mini', title:'Cambiar la fecha de esta compra', 'aria-label':'Fecha ' + dd + ': cambiar', onclick:() => abrirDetalle(m.id, 'fecha')}, dd)
          : dd), el('td',{}, m.desc, aj ? el('span',{class:'tag',text:'ajustada'}) : null, el('span',{class:'desc',text:m.comercio + ' · ' + etiqueta(m.mes) + cuota(m)}),
          api.detalle ? el('button',{type:'button', class:'btn ghost mini', onclick:() => abrirDetalle(m.id, false), title:'Ver el mensaje original'}, 'Ver mensaje') : null,
          api.editar ? el('button',{type:'button', class:'btn ghost mini', onclick:() => abrirDetalle(m.id, 'editar'), title:'Editar los datos de esta compra'}, 'Editar') : null),
        el('td',{class:'hide-sm',text:m.tarjeta || '—'}), estadoCelda(m),
        el('td',{}, catSelect(effCat(m), c => writeAjuste(m, c), 'm-' + m.id, m)), el('td',{class:'num' + (m.duplicado_de ? ' tachado' : ''),text:COP(m.valor)}))); });
    const panel = el('section',{class:'panel'}, el('div',{class:'inline'}, el('h2',{text:data.length.toLocaleString('es-CO') + ' movimientos'}), el('span',{class:'note',text:'Total ' + COP(sum(data)) + (data.some(m => m.duplicado_de) ? ' · sin contar posibles duplicados' : '')})),
      el('p',{class:'note',text:'Cambia la categoría o edita los datos de cualquier compra; cada cambio queda en la bitácora. Las pendientes se clasifican respondiendo por WhatsApp. Toca los encabezados para ordenar.'}),
      el('div',{class:'tbl'}, el('table',{}, el('thead',{}, el('tr',{}, th('fecha','Fecha','num'), el('th',{text:'Descripción'}), el('th',{class:'hide-sm',text:'Tarjeta'}), el('th',{text:'Estado'}), th('cat','Categoría'), th('valor','Valor','num'))), tb)));
    if (data.length > S.limit) panel.append(el('div',{class:'more'}, el('button',{type:'button', class:'btn', onclick:() => { S.limit += 300; render(); }}, 'Mostrar ' + Math.min(300, data.length - S.limit) + ' más')));
    v.append(panel);
  }

  // ---------- shell ----------
  function fillFilters() {
    const fm = $('fMes'), fc = $('fCat'), ft = $('fTarjeta');
    if (fm.options.length === 1) S.data.meses.forEach(m => fm.append(el('option',{value:m.mes, text:m.etiqueta})));
    if (ft.options.length === 1) (S.data.tarjetas || []).forEach(t => ft.append(el('option',{value:t.id, text:t.nombre})));
    ft.value = S.f.tarjeta; $('fEstado').value = S.f.estado;
    fc.replaceChildren(el('option',{value:'', text:'Todas'}), ...allCats().map(c => el('option',{value:c, text:c})));
    fm.value = S.f.mes; fc.value = S.f.cat;
    $('fMonto').value = S.f.monto;
    const q = $('fQ'); if (q !== document.activeElement) q.value = S.f.q;
  }
  function setFilter(k, val) { S.f[k] = val; S.limit = 200; render(); }
  function render() {
    if (!S.data || !vivo) return;
    refreshColors(); fillFilters();
    document.querySelectorAll('.explorador .tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
    const v = $('view'); const y = window.scrollY;
    const nv = el('main',{id:'view', style:'display:flex;flex-direction:column;gap:16px'});
    const pe = panelExtracto(); if (pe) nv.append(pe);
    const be = $('bExtracto'); if (be) be.disabled = !!(S.extracto && S.extracto.cargando);
    const banda = porAtender(); if (banda) nv.append(banda);
    if (S.tab === 'categorias') viewCategorias(nv);
    else if (!S.data.movimientos.length) nv.append(el('p',{class:'empty',text:'Todavía no hay movimientos.'}));
    else ({resumen:viewResumen, mes:viewMes, comparar:viewComparar, reclasificar:viewReclasificar, movimientos:viewMovimientos})[S.tab](nv);
    v.replaceWith(nv); window.scrollTo(0, y);
  }
  function setTab(t) { if (!['resumen','mes','comparar','reclasificar','movimientos','categorias'].includes(t)) t = 'resumen'; S.tab = t; try { history.replaceState(null, '', '#' + t); } catch (e) {} render(); }

  const quitar = [];
  const on = (node, ev, fn) => { node.addEventListener(ev, fn); quitar.push(() => node.removeEventListener(ev, fn)); };
  document.querySelectorAll('.explorador .tabs button').forEach(b => on(b, 'click', () => { setTab(b.dataset.tab); window.scrollTo(0, 0); }));
  on($('fMes'), 'change', e => setFilter('mes', e.target.value));
  on($('fCat'), 'change', e => setFilter('cat', e.target.value));
  on($('fTarjeta'), 'change', e => setFilter('tarjeta', e.target.value));
  on($('fEstado'), 'change', e => setFilter('estado', e.target.value));
  on($('fMonto'), 'change', e => setFilter('monto', e.target.value));
  let qT; on($('fQ'), 'input', e => { clearTimeout(qT); qT = setTimeout(() => setFilter('q', e.target.value), 200); });
  on($('fReset'), 'click', () => { S.f = {mes:'', cat:'', monto:'', q:'', tarjeta:'', estado:''}; render(); });
  let rT, anchoPrevio = window.innerWidth;
  on(window, 'resize', () => { if (window.innerWidth === anchoPrevio) return; anchoPrevio = window.innerWidth; clearTimeout(rT); rT = setTimeout(render, 150); });
  const bF = $('bFiltros'), fF = $('filtros');
  if (bF && fF) on(bF, 'click', () => { const abierto = fF.classList.toggle('abierto'); bF.setAttribute('aria-expanded', String(abierto)); });

  const bC = $('bCategoria');
  if (bC && api.crearCategoria) on(bC, 'click', () => nuevaCategoria());
  const bE = $('bExtracto'), fE = $('fExtracto');
  if (bE && fE && api.cargarExtracto) {
    on(bE, 'click', () => fE.click());
    on(fE, 'change', () => { const f = fE.files && fE.files[0]; fE.value = ''; subirExtracto(f); });
  }

  /** Lee los datos; tras cargar un extracto se vuelve a llamar sin cambiar de pestaña. */
  async function cargarDatos() {
    const r = await api.datos();
    if (!vivo) return;
    if (r.status === 401) { api.sinSesion(); return; }
    if (r.status !== 200) throw new Error(String(r.status));
    S.data = r.json;
    // Primera carga: el filtro de mes empieza en el mes actual (hora de Bogotá). Si el mes aún
    // no tiene compras, se usa el último mes con datos para que el selector muestre algo válido.
    if (!S.mesInicial) {
      S.mesInicial = true;
      const meses = S.data.meses || []; const actual = mesActual();
      if (meses.some(m => m.mes === actual)) S.f.mes = actual;
      else if (meses.length) S.f.mes = meses[meses.length - 1].mes;
    }
  }
  setSave('', 'Cargando…');
  cargarDatos().then(() => {
    if (!vivo || !S.data) return;
    const h = location.hash.slice(1); S.tab = ['resumen','mes','comparar','reclasificar','movimientos','categorias'].includes(h) ? h : 'resumen';
    setSave('ok', 'Datos en vivo · los cambios se guardan en la base'); render();
  }).catch(() => { if (vivo) $('view').replaceChildren(el('p',{class:'empty',text:'No se pudieron cargar los movimientos. Recarga la página.'})); setSave('local', 'Sin datos'); });

  return () => { vivo = false; quitar.forEach(f => f()); clearTimeout(toastTimer); };
}
