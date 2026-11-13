// v18 · Sin Leads duplicados. Cada caso reproduce un camino por el que v17 podía crear el
// mismo Lead dos veces (falla con main) y la prueba de estrés corre cientos de escenarios
// aleatorios con caídas de red, bloqueos, rechazos, reintentos y recuperaciones.
// Invariante: cada Contact__c se crea UNA sola vez, y lo que el cliente cree que falló
// de verdad no existe en Salesforce (si no, un Retry lo duplicaría).
const assert = require('assert');
const { cargarBackend, serviciosGoogleFalsos } = require('./lib/cargar');
const { crearBulkFalso, parsearCsv } = require('./lib/bulk-falso');

const INSTANCIA = 'https://docplanner.my.salesforce.com';
const USUARIO = 'usuario.prueba@docplanner.com';
const HEADERS = ['Contact__c', 'Company', 'LastName', 'Email', 'OwnerId'];
const OWNERS = ['005P400000FpACnIAN', '005P400000Fp9aHIAR', '005P400000FpZZZIAR', '005P400000FpYYYIAR', '005P400000FpXXXIAR'];
const BASE = { sid: 'SID', instanceUrl: INSTANCIA, object: 'Lead', operation: 'insert', userEmail: USUARIO };
let nReq = 0;
const nuevoReq = () => 'req_v18_' + String(++nReq).padStart(6, '0');

function filas(n, owner, extra = '') {
  return Array.from({ length: n }, (_, i) => ['003DUP' + String(i).padStart(9, '0'), 'Clinica ' + i + extra, 'Doc' + i, 'doc' + i + '@test.local', owner(i)]);
}
function montar(opcionesBulk = {}, opcionesGoogle = {}) {
  const g = serviciosGoogleFalsos(opcionesGoogle);
  const bulk = crearBulkFalso(opcionesBulk);
  const ctx = cargarBackend(bulk.UrlFetchApp, process.env.CODE_GS || null, g.globales);
  const iniciar = (rows, req, extra) => ctx.iniciarImportBulk(Object.assign({}, BASE, { headers: HEADERS, rows, clientRequestId: req }, extra || {}));
  const recuperar = p => ctx.recuperarResultadoJob(Object.assign({}, BASE, p));
  const contactosCreados = () => bulk.creados.map(c => c.fila.Contact__c);
  const sinDuplicados = () => { const c = contactosCreados(); assert.strictEqual(new Set(c).size, c.length, 'Leads duplicados: ' + (c.length - new Set(c).size)); };
  return { g, bulk, ctx, iniciar, recuperar, contactosCreados, sinDuplicados };
}
const filasCsv = csv => Math.max(0, parsearCsv(csv || '').length - 1);
const limpiarCache = g => { g.cache.clear(); g.venceCache.clear(); };

// PRNG con semilla (cada escenario se puede repetir con su número)
function mulberry32(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

module.exports = function (prueba, setGrupo, html) {
  if (html) pruebasFrontend(prueba, setGrupo, html);
  // Si la preparación de un grupo truena (p. ej. con el backend de main), falla solo ese grupo.
  const bloque = (nombre, fn) => { try { fn(); } catch (e) { prueba(nombre + ' (preparación)', () => { throw e; }); } };
  setGrupo('v18 · Sin Leads duplicados: importStart');
  {
    const m = montar({ falloSubida: [1] });
    const req = nuevoReq();
    const rows = filas(500, i => OWNERS[i % 5], ' ' + 'x'.repeat(2500));   // filas no enviadas de más de 100 KB
    let r = null, error = null;
    try { r = m.iniciar(rows, req); } catch (e) { error = e; }
    prueba('resultado de más de 100 KB: no truena después de crear los jobs', () => {
      assert.ok(!error, error && error.message);
      assert.strictEqual(r.filasNoEnviadas.length, 50);
    });
    prueba('…y el mismo clientRequestId devuelve los mismos jobs y rearma las filas no enviadas', () => {
      const otra = m.iniciar(rows, req);
      assert.strictEqual(otra.repetido, true);
      assert.deepStrictEqual([...otra.jobIds], [...r.jobIds]);
      assert.strictEqual(m.bulk.jobs.length, 10);
      assert.deepStrictEqual(otra.filasNoEnviadas.map(f => f[0]).sort(), r.filasNoEnviadas.map(f => f[0]).sort());
      m.sinDuplicados();
    });
  }
  {
    let n = 0;
    const m = montar({ excepcion: p => (p.paso === 'cerrar' && n++ === 0 ? 'despues' : '') });
    const req = nuevoReq();
    const rows = filas(500, i => OWNERS[i % 5]);
    let r = null, error = null;
    try { r = m.iniciar(rows, req); } catch (e) { error = e; }
    prueba('se pierde la respuesta del cierre (Salesforce sí cerró): los jobs siguen vivos, ninguna fila "no enviada"', () => {
      assert.ok(!error, error && error.message);
      assert.strictEqual(r.jobIds.length, 10);
      assert.strictEqual(r.filasNoEnviadas.length, 0);
    });
    prueba('…y reintentar con el mismo clientRequestId no crea otro import', () => {
      const otra = m.iniciar(rows, req);
      assert.strictEqual(otra.repetido, true);
      assert.strictEqual(m.bulk.jobs.length, 10);
      assert.strictEqual(m.contactosCreados().length, 500);
      m.sinDuplicados();
    });
  }
  bloque('cierre que miente', () => {
    const m = montar({ cierreMiente: [3] });
    const r = m.iniciar(filas(500, i => OWNERS[i % 5]), nuevoReq());
    prueba('el cierre responde 500 pero sí cerró: ese job sigue vivo y sus filas no vuelven como no enviadas', () => {
      assert.strictEqual(r.jobIds.length, 10);
      assert.strictEqual(r.filasNoEnviadas.length, 0);
      assert.ok(r.jobIds.includes(m.bulk.jobs[3].id));
    });
  });
  bloque('cierre que falla', () => {
    const m = montar({ falloCierre: [2] });
    const r = m.iniciar(filas(500, i => OWNERS[i % 5]), nuevoReq());
    prueba('el cierre falla sin cerrar: se reintenta y el job queda vivo', () => {
      assert.strictEqual(r.jobIds.length, 10);
      assert.strictEqual(r.filasNoEnviadas.length, 0);
    });
  });
  {
    const m = montar({ falloSubida: [1] });
    const req = nuevoReq();
    const rows = filas(500, i => OWNERS[i % 5]);
    const orig = m.ctx.registrarAuditoria;
    m.ctx.registrarAuditoria = (u, op, st, d) => { if (st === 'jobs_abortados') throw new Error('Sheets no responde'); return orig(u, op, st, d); };
    let e1 = null;
    try { m.iniciar(rows, req); } catch (e) { e1 = e; }
    m.ctx.registrarAuditoria = orig;
    prueba('una excepción después de cerrar jobs NO borra la marca: el reintento avisa en vez de duplicar', () => {
      assert.ok(e1, 'debía tronar');
      const jobsAntes = m.bulk.jobs.length;
      assert.throws(() => m.iniciar(rows, req), /ya se mandó a Salesforce \(lote_/);
      assert.strictEqual(m.bulk.jobs.length, jobsAntes);
      m.sinDuplicados();
    });
  }
  {
    const m = montar({ falloCrear: [3] });
    const req = nuevoReq();
    const rows = filas(500, i => OWNERS[i % 5]);
    prueba('si falla crear un job (nada se subió), el reintento sí puede crear de nuevo', () => {
      assert.throws(() => m.iniciar(rows, req), /Error creando Job/);
      m.bulk.opciones.falloCrear = [];
      const r = m.iniciar(rows, req);
      assert.ok(!r.repetido && r.jobIds.length === 10);
    });
  }
  bloque('estado desconocido al cerrar', () => {
    let estadoCaido = true;
    const m = montar({ excepcion: p => ((p.paso === 'cerrar' || (p.paso === 'estado' && estadoCaido)) ? 'antes' : '') });
    m.ctx.JOB_ABIERTO_MAX_MS = -1;   // cualquier job Open se aborta al consultarlo (con 0, en el mismo milisegundo no)
    const r = m.iniciar(filas(60, i => OWNERS[i % 2]), nuevoReq(), { filasPorJob: 30 });
    estadoCaido = false;
    m.bulk.opciones.excepcion = null;
    prueba('estado desconocido al cerrar → el job sigue vivo (no se devuelven sus filas)', () => {
      assert.strictEqual(r.jobIds.length, 2);
      assert.strictEqual(r.filasNoEnviadas.length, 0);
    });
    prueba('…y un job que quedó Open se aborta al consultarlo: sus filas salen sin procesar para reintentarlas', () => {
      const est = m.ctx.consultarEstadoJob(Object.assign({}, BASE, { jobIds: r.jobIds }));
      assert.strictEqual(est.terminado, true);
      const res = m.recuperar({ jobIds: r.jobIds });
      assert.strictEqual(filasCsv(res.unprocessedCsv), 60);
      assert.strictEqual(m.contactosCreados().length, 0);
    });
  });

  setGrupo('v18 · Sin Leads duplicados: reintento por bloqueo y recuperar');
  bloque('reintento por bloqueo de un lote', () => {
    const m = montar({ lock: f => /[05]$/.test(f.Contact__c) });
    const r = m.iniciar(filas(200, i => OWNERS[i % 2]), nuevoReq());
    const res = m.recuperar({ jobIds: r.jobIds, loteId: r.loteId, reintentarLock: true, cierreAutomatico: true });
    prueba('recuperar solo UNO de los jobs del lote encuentra el reintento por bloqueo', () => {
      assert.ok(res.reintentoLock, 'no hubo reintento');
      const uno = m.recuperar({ jobIds: [r.jobIds[0]] });
      assert.strictEqual(uno.incluyeReintentoLock, true);
      assert.ok(!/UNABLE_TO_LOCK_ROW/.test(uno.failedCsv), 'las filas bloqueadas salen como fallidas');
    });
    prueba('…también sin caché (lo busca en la auditoría con cualquiera de sus jobs)', () => {
      limpiarCache(m.g);
      const uno = m.recuperar({ jobIds: [r.jobIds[1]] });
      assert.strictEqual(uno.incluyeReintentoLock, true);
      assert.ok(!/UNABLE_TO_LOCK_ROW/.test(uno.failedCsv));
    });
    prueba('…y con el Job ID en 15 caracteres', () => {
      limpiarCache(m.g);
      const uno = m.recuperar({ jobId: r.jobIds[2].slice(0, 15) });
      assert.strictEqual(uno.incluyeReintentoLock, true);
    });
    prueba('recuperar por lote después de una recuperación manual (cuya auditoría trae el job de reintento)', () => {
      const manual = m.recuperar({ loteId: r.loteId });
      m.ctx.registrarAuditoria(USUARIO, 'recuperarJob', m.ctx.estadoAuditoriaRecuperar(manual), m.ctx.detalleAuditoriaJobs(manual));
      limpiarCache(m.g);
      const otra = m.recuperar({ loteId: r.loteId });
      assert.ok(!/UNABLE_TO_LOCK_ROW/.test(otra.failedCsv), 'las filas bloqueadas salen como fallidas');
      assert.strictEqual(filasCsv(otra.successCsv), 200);
      m.sinDuplicados();
    });
  });
  bloque('bloqueo envuelto', () => {
    const m = montar({ lock: f => /3$/.test(f.Contact__c), lockEnvuelto: true });
    const r = m.iniciar(filas(100, i => OWNERS[i % 2]), nuevoReq());
    const res = m.recuperar({ jobIds: r.jobIds, loteId: r.loteId, reintentarLock: true });
    prueba('un bloqueo envuelto en el error de un trigger también se reintenta solo', () => {
      assert.ok(res.reintentoLock && res.reintentoLock.filas === 10, JSON.stringify(res.reintentoLock));
      assert.ok(!/UNABLE_TO_LOCK_ROW/.test(res.failedCsv));
    });
  });
  bloque('reintento en curso', () => {
    const m = montar({ lock: f => /7$/.test(f.Contact__c) });
    const r = m.iniciar(filas(100, i => OWNERS[i % 2]), nuevoReq());
    prueba('si otra petición está lanzando el reintento, no se lanza otro y esas filas no salen como fallidas', () => {
      m.g.cache.set('lockr_' + r.jobIds[0], 'creando');
      const jobs = m.bulk.jobs.length;
      const res = m.recuperar({ jobIds: r.jobIds, loteId: r.loteId, reintentarLock: true });
      assert.strictEqual(m.bulk.jobs.length, jobs, 'se lanzó otro reintento');
      assert.ok(res.reintentoLockEnCurso && res.reintentoLockEnCurso.filas === 10, JSON.stringify(res.reintentoLockEnCurso));
      assert.ok(!/UNABLE_TO_LOCK_ROW/.test(res.failedCsv));
    });
    prueba('con el candado del script ocupado, tampoco', () => {
      m.g.cache.delete('lockr_' + r.jobIds[0]);
      m.g.opciones.lockOcupado = true;
      const jobs = m.bulk.jobs.length;
      const res = m.recuperar({ jobIds: r.jobIds, loteId: r.loteId, reintentarLock: true });
      m.g.opciones.lockOcupado = false;
      assert.strictEqual(m.bulk.jobs.length, jobs);
      assert.ok(res.reintentoLockEnCurso);
    });
    prueba('después, el reintento se lanza una sola vez aunque se pida dos veces', () => {
      const a = m.recuperar({ jobIds: r.jobIds, loteId: r.loteId, reintentarLock: true });
      const b = m.recuperar({ jobIds: r.jobIds, loteId: r.loteId, reintentarLock: true });
      assert.ok(a.reintentoLock && b.reintentoLock && a.reintentoLock.jobId === b.reintentoLock.jobId);
      m.sinDuplicados();
    });
  });
  bloque('lote con job abortado', () => {
    const m = montar({ falloSubida: [1] });
    const r = m.iniciar(filas(500, i => OWNERS[i % 5]), nuevoReq());
    prueba('recuperar un lote sin caché salta el job abortado al iniciar ("vivos=")', () => {
      limpiarCache(m.g);
      const res = m.recuperar({ loteId: r.loteId });
      assert.deepStrictEqual([...res.jobIds], [...r.jobIds]);
      assert.strictEqual(res.jobState, 'JobComplete');
    });
    prueba('auditoría de v17 (sin "vivos="): se restan los jobIds de jobs_abortados', () => {
      const hoja = m.g.spreadsheets.get('sheet_prueba').getSheets()[0];
      const lote = 'lote_0123456789abcdef';
      hoja.appendRow([new Date(), USUARIO, 'import', 'iniciado', 'jobId=750AAAAAAAAAAAAAAA; lote=' + lote + '; jobIds=750AAAAAAAAAAAAAAA,750BBBBBBBBBBBBBBB,750CCCCCCCCCCCCCCC; rows=150']);
      hoja.appendRow([new Date(), USUARIO, 'import', 'jobs_abortados', 'lote=' + lote + '; jobIds=750BBBBBBBBBBBBBBB; rows=50; Error subiendo CSV']);
      assert.deepStrictEqual([...m.ctx.buscarJobsDeLote(lote)], ['750AAAAAAAAAAAAAAA', '750CCCCCCCCCCCCCCC']);
    });
  });

  // ── Estrés ─────────────────────────────────────────────────────
  // Un cliente que sigue las reglas del frontend v18: reintenta importStart con el MISMO
  // clientRequestId mientras las filas no cambien, no vuelve a importar mientras haya un lote
  // pendiente (primero lo recupera), y el Retry solo manda las filas que fallaron.
  setGrupo('v18 · Estrés: cada Contact__c se crea una sola vez');
  const ESCENARIOS = Number(process.env.ESTRES || 320);
  const resumen = { escenarios: 0, filas: 0, fallasRed: 0, completos: 0, problemas: [] };
  for (let semilla = 1; semilla <= ESCENARIOS; semilla++) {
    const p = escenario(semilla);
    resumen.escenarios++; resumen.filas += p.n; resumen.fallasRed += p.fallasRed;
    if (p.completo) resumen.completos++;
    if (p.problema) resumen.problemas.push('semilla ' + semilla + ': ' + p.problema);
  }
  prueba(`${resumen.escenarios} escenarios aleatorios (${resumen.filas} filas, ${resumen.fallasRed} caídas de red): ningún Lead duplicado y el cliente nunca cree "fallida" una fila que sí se creó`, () => {
    assert.deepStrictEqual(resumen.problemas.slice(0, 5), []);
  });
  prueba(`la gran mayoría termina completa (${resumen.completos} de ${resumen.escenarios}): todas las filas buenas creadas`, () => {
    assert.ok(resumen.completos >= resumen.escenarios * 0.9, resumen.completos + ' completos');
  });
};

function escenario(semilla) {
  const rnd = mulberry32(semilla * 7919);
  const n = 1 + Math.floor(rnd() * 240);
  const nReps = 1 + Math.floor(rnd() * 12);
  const pLock = rnd() < 0.5 ? rnd() * 0.25 : 0;
  const pRechazo = rnd() < 0.4 ? rnd() * 0.1 : 0;
  const pRed = rnd() < 0.8 ? rnd() * 0.12 : 0;
  const rows = Array.from({ length: n }, (_, i) => ['003S' + String(semilla).padStart(5, '0') + String(i).padStart(6, '0'), 'Clinica ' + i, 'Doc' + i, 'd' + i + '@t.local',
    '005P4000' + String(Math.floor(rnd() * nReps)).padStart(7, '0')]);
  const conLock = new Set(rows.filter(() => rnd() < pLock).map(r => r[0]));
  const rechazadas = new Set(rows.filter(() => rnd() < pRechazo).map(r => r[0]));
  let fallasRed = 0;
  const nJobsMax = 10;
  const opciones = {
    lock: f => conLock.has(f.Contact__c),
    lockEnvuelto: rnd() < 0.3,
    rechazo: f => (rechazadas.has(f.Contact__c) ? 'FIELD_CUSTOM_VALIDATION_EXCEPTION:no se puede:--' : ''),
    sondeosParaTerminar: Math.floor(rnd() * 3),
    cierreMiente: rnd() < 0.2 ? [Math.floor(rnd() * nJobsMax)] : [],
    falloCierre: rnd() < 0.2 ? [Math.floor(rnd() * nJobsMax)] : [],
    falloSubida: rnd() < 0.15 ? [Math.floor(rnd() * nJobsMax)] : [],
    excepcion: () => {
      if (fallasRed >= 30 || rnd() >= pRed) return '';
      fallasRed++;
      return rnd() < 0.5 ? 'antes' : 'despues';
    }
  };
  const m = montar(opciones);
  m.ctx.JOB_ABIERTO_MAX_MS = -1;   // cualquier job Open se aborta al consultarlo (con 0, en el mismo milisegundo no)
  const reparto = { filasPorJob: 10 + Math.floor(rnd() * 60), jobsALaVez: 1 + Math.floor(rnd() * 10) };

  const estado = new Map();       // Contact__c → 'ok' | 'fail' | 'pend'
  rows.forEach(r => estado.set(r[0], 'nueva'));
  const pendientes = [];          // refs por recuperar: { loteId } o { jobIds }
  const intentar = fn => {        // el frontend reintenta lo que falla por red
    let ultimo = null;
    for (let t = 0; t < 8; t++) { try { return { ok: true, v: fn() }; } catch (e) { ultimo = e; if (/ya se mandó/.test(e.message)) break; } }
    return { ok: false, e: ultimo };
  };
  const aplicar = (d, enviadas) => {
    const ok = parsearCsv(d.successCsv || '').slice(1).map(f => f[2]);
    const fail = parsearCsv(d.failedCsv || '').slice(1).map(f => f[2]).concat(parsearCsv(d.unprocessedCsv || '').slice(1).map(f => f[0]));
    ok.forEach(c => estado.set(c, 'ok'));
    fail.forEach(c => { if (estado.get(c) !== 'ok') estado.set(c, 'fail'); });
    (enviadas || []).forEach(c => { if (!ok.includes(c) && !fail.includes(c) && estado.get(c) !== 'ok') estado.set(c, 'pend'); });
  };
  const esperar = jobIds => {
    for (let k = 0; k < 6; k++) {
      const e = intentar(() => m.ctx.consultarEstadoJob(Object.assign({}, BASE, { jobIds })));
      if (e.ok && e.v.terminado) return true;
    }
    return false;
  };

  let reqActual = '', firmaActual = '', problema = '';
  for (let ronda = 0; ronda < 14; ronda++) {
    // 1) primero los lotes pendientes (el frontend no deja importar encima de ellos)
    for (let k = pendientes.length - 1; k >= 0; k--) {
      const ref = pendientes[k];
      if (ref.jobIds && !esperar(ref.jobIds)) continue;
      const d = intentar(() => m.recuperar(ref));
      if (d.ok && !d.v.stillProcessing && !d.v.resultsError) {
        aplicar(d.v, ref.enviadas);
        pendientes.splice(k, 1);
      }
    }
    if (pendientes.length) continue;
    const porEnviar = rows.filter(r => ['nueva', 'fail'].includes(estado.get(r[0])));
    if (!porEnviar.length) break;
    // 2) import (o Retry de las fallidas): mismo clientRequestId mientras las filas no cambien
    const firma = porEnviar.map(r => r[0]).join('|');
    if (firma !== firmaActual) { firmaActual = firma; reqActual = 'req_s' + semilla + '_' + ronda + '_' + porEnviar.length; }
    const enviadas = porEnviar.map(r => r[0]);
    const ini = intentar(() => m.iniciar(porEnviar, reqActual, reparto));
    if (!ini.ok) {
      const lote = ((ini.e && ini.e.message) || '').match(/lote_[a-f0-9]{16}/);
      if (lote) { pendientes.push({ loteId: lote[0], enviadas }); firmaActual = ''; }
      continue;
    }
    const r = ini.v;
    const noEnv = new Set((r.filasNoEnviadas || []).map(f => f[0]));
    noEnv.forEach(c => estado.set(c, 'fail'));
    const enLote = enviadas.filter(c => !noEnv.has(c));
    enLote.forEach(c => estado.set(c, 'pend'));
    if (!esperar(r.jobIds)) { pendientes.push({ loteId: r.loteId, enviadas: enLote }); firmaActual = ''; continue; }
    const d = intentar(() => m.recuperar({ jobIds: r.jobIds, loteId: r.loteId, reintentarLock: true, cierreAutomatico: true }));
    firmaActual = '';   // resultado final (o pendiente): el siguiente envío lleva otro clientRequestId
    if (!d.ok || d.v.stillProcessing || d.v.resultsError) { pendientes.push({ loteId: r.loteId, enviadas: enLote }); continue; }
    aplicar(d.v, enLote);
    if (d.v.reintentoLock) {
      const idL = d.v.reintentoLock.jobId;
      const enLock = enLote.filter(c => estado.get(c) === 'pend');
      if (!esperar([idL])) { pendientes.push({ jobIds: [idL], enviadas: enLock }); continue; }
      const d2 = intentar(() => m.recuperar({ jobIds: [idL], esReintentoLock: true }));
      if (!d2.ok || d2.v.resultsError) { pendientes.push({ jobIds: [idL], enviadas: enLock }); continue; }
      aplicar(d2.v, enLock);
    }
    if (enLote.some(c => estado.get(c) === 'pend')) pendientes.push({ loteId: r.loteId, enviadas: enLote.filter(c => estado.get(c) === 'pend') });
  }

  // Invariantes
  const creados = m.contactosCreados();
  const veces = new Map();
  creados.forEach(c => veces.set(c, (veces.get(c) || 0) + 1));
  const dup = [...veces].filter(([, v]) => v > 1);
  if (dup.length) problema = dup.length + ' Contact__c duplicados (p. ej. ' + dup[0][0] + ' ×' + dup[0][1] + ')';
  const creyoFallida = rows.filter(r => estado.get(r[0]) === 'fail' && veces.has(r[0]));
  if (!problema && creyoFallida.length) problema = creyoFallida.length + ' fila(s) que el cliente cree fallidas sí existen (un Retry las duplicaría)';
  const okSinCrear = rows.filter(r => estado.get(r[0]) === 'ok' && !veces.has(r[0]));
  if (!problema && okSinCrear.length) problema = okSinCrear.length + ' fila(s) marcadas OK que no existen';
  const completo = !pendientes.length && rows.every(r => (rechazadas.has(r[0]) ? !veces.has(r[0]) : veces.get(r[0]) === 1));
  return { n, fallasRed, completo, problema };
}

// ── Frontend: funciones reales de index.html (sin navegador) ─────
function pruebasFrontend(prueba, setGrupo, html) {
  const { cargarFunciones: cargarAhora } = require('./lib/cargar');
  setGrupo('v18 · Sin duplicados en el navegador (index.html)');
  const COLS = ['Contact__c', 'LastName', 'OwnerId'];
  const cfg = { object: 'Lead', action: 'insert', extId: '', sfHeaders: COLS, colNames: COLS };
  const fila = (c, n) => [c, 'Doc' + n, '005P400000FpACnIAN'];

  prueba('el clientRequestId es el mismo mientras se manden las mismas filas (un segundo clic no crea otro import)', () => {
    const m = cargarAhora(html, ['hashTexto', 'firmaEnvio', 'nuevoRequestId', 'requestIdPara', 'olvidarRequestId'],
      '{ firmaEnvio, requestIdPara, olvidarRequestId }', { reqPorFirma: { firma: '', id: '' }, window: globalThis, crypto: require('crypto') });
    const filasA = [fila('003A00000000001', 1)], filasB = [fila('003A00000000002', 2)];
    const a1 = m.requestIdPara(m.firmaEnvio(cfg, filasA));
    assert.strictEqual(m.requestIdPara(m.firmaEnvio(cfg, filasA.map(r => r.slice()))), a1);
    assert.notStrictEqual(m.requestIdPara(m.firmaEnvio(cfg, filasB)), a1);
    m.olvidarRequestId();
    assert.notStrictEqual(m.requestIdPara(m.firmaEnvio(cfg, filasA)), a1, 'tras un resultado final debe cambiar');
  });

  const almacen = () => {
    const datos = new Map();
    return { getItem: k => (datos.has(k) ? datos.get(k) : null), setItem: (k, v) => datos.set(k, String(v)), removeItem: k => datos.delete(k), datos };
  };
  const FN_PEND = ['llaveJobPendiente', 'leerPendientes', 'escribirPendientes', 'refPendiente', 'coincidePendiente',
    'guardarJobPendiente', 'limpiarJobPendiente', 'leerJobPendiente', 'hashTexto', 'llaveEnvio', 'llaveContacto', 'pendientesQueChocan'];
  const pend = ls => cargarAhora(html, FN_PEND, '{ guardarJobPendiente, limpiarJobPendiente, leerPendientes, pendientesQueChocan, llaveContacto }',
    { localStorage: ls, JOB_STORAGE_KEY: 'catalyst_job_pendiente', JOB_STORAGE_PREFIJO: 'catalyst_job_pendiente:', loggedInEmail: 'u@docplanner.com' });

  prueba('pendientes: el import y su reintento quedan los dos (antes uno pisaba al otro)', () => {
    const p = pend(almacen());
    p.guardarJobPendiente({ loteId: 'lote_aaaaaaaaaaaaaaaa', jobIds: ['750A'], llaves: ['003A00000000001'] });
    p.guardarJobPendiente({ loteId: '', jobIds: ['750LOCK'], llaves: ['003A00000000002'], nota: 'reintento por bloqueo' });
    assert.strictEqual(p.leerPendientes().length, 2);
    p.limpiarJobPendiente('lote_aaaaaaaaaaaaaaaa', ['750A']);
    assert.deepStrictEqual(p.leerPendientes().map(x => x.jobIds[0]), ['750LOCK']);
  });
  prueba('pendientes: el formato de v17 (un solo objeto) se sigue leyendo', () => {
    const ls = almacen();
    ls.setItem('catalyst_job_pendiente:u@docplanner.com', JSON.stringify({ loteId: 'lote_bbbbbbbbbbbbbbbb', jobIds: ['750B'], fecha: new Date().toISOString() }));
    assert.strictEqual(pend(ls).leerPendientes()[0].loteId, 'lote_bbbbbbbbbbbbbbbb');
  });
  prueba('una fila que ya va en un lote pendiente se detecta aunque venga en 18 caracteres', () => {
    const p = pend(almacen());
    p.guardarJobPendiente({ loteId: 'lote_cccccccccccccccc', jobIds: ['750C'], llaves: [p.llaveContacto(fila('003A00000000001', 1), cfg)] });
    assert.strictEqual(p.pendientesQueChocan([fila('003A00000000001AAA', 1)], cfg).length, 1);
    assert.strictEqual(p.pendientesQueChocan([fila('003A00000000009', 9)], cfg).length, 0);
  });

  prueba('filas sin resultado → "En proceso" y al recuperar toman su resultado sin tocar el resto', () => {
    const IMPORT_RESULT_HEADERS = COLS.concat(['__Status', '__Id', '__Action', '__Errors']);
    const glob = { IMPORT_RESULT_HEADERS, ESTADO_EN_PROCESO: 'En proceso', importResultRows: [] };
    const m = cargarAhora(html, ['llaveFila', 'llaveEnvio', 'filasFaltantes', 'filaEnProceso', 'juntarRecuperado'],
      '{ filasFaltantes, filaEnProceso, juntar: (ok, fail, refs, c, filas) => { importResultRows = filas; const n = juntarRecuperado(ok, fail, refs, c); return { n, filas: importResultRows }; } }', glob);
    const res = (f, st) => ({ Contact__c: f[0], LastName: f[1], OwnerId: f[2], __Status: st, __Id: st === 'Succeeded' ? '00Q1' : '', __Action: '', __Errors: '' });
    const enviadas = [fila('003A1', 1), fila('003A2', 2), fila('003A3', 3)];
    const faltan = m.filasFaltantes(enviadas, [res(enviadas[0], 'Succeeded')], [res(enviadas[1], 'Failed')], cfg);
    assert.deepStrictEqual(faltan.map(f => f[0]), ['003A3']);
    const tabla = [res(enviadas[0], 'Succeeded'), res(enviadas[1], 'Failed'), m.filaEnProceso(faltan[0], cfg, '750LOCK')];
    assert.strictEqual(tabla[2].__Status, 'En proceso');
    const r = m.juntar([res(enviadas[2], 'Succeeded')], [], ['750LOCK'], cfg, tabla);
    assert.strictEqual(r.n, 1);
    assert.deepStrictEqual(r.filas.map(x => x.__Status), ['Succeeded', 'Failed', 'Succeeded']);
  });
}
