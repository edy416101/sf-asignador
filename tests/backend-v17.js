// Pruebas v17 del backend (Code.gs real) contra la Bulk API falsa y servicios de Google falsos.
// Nada sale a la red: UrlFetchApp es un objeto en memoria.
const assert = require('assert');
const { cargarBackend, serviciosGoogleFalsos } = require('./lib/cargar');
const { crearBulkFalso, parsearCsv } = require('./lib/bulk-falso');
const SF = require('./lib/sf-falso');

const INSTANCIA = 'https://docplanner.my.salesforce.com';
const OWNERS = ['005P400000FpACnIAN', '005P400000Fp9aHIAR', '005P400000FpZZZIAR', '005P400000FpYYYIAR', '005P400000FpXXXIAR'];
const HEADERS = ['Contact__c', 'Company', 'LastName', 'Email', 'OwnerId'];

// n filas; el owner de cada fila lo decide repartoOwners(i)
function filas(n, repartoOwners) {
  return Array.from({ length: n }, (_, i) => [
    '003TEST' + String(i).padStart(8, '0'), 'Clinica ' + i, 'Doc' + i, 'doc' + i + '@test.local', repartoOwners(i)
  ]);
}

// UrlFetchApp que manda tokeninfo a un Google falso y lo demás a la Bulk API falsa
function urlFetchCombinado(bulk, google) {
  const f = (url, o) => (/oauth2\.googleapis\.com/.test(url) ? google(url) : bulk.UrlFetchApp.fetch(url, o));
  return { fetch: f, fetchAll: reqs => reqs.map(r => f(r.url, r)) };
}

function montar(opcionesBulk = {}, google) {
  const bulk = crearBulkFalso(opcionesBulk);
  const g = serviciosGoogleFalsos();
  const googleLlamadas = [];
  const googleFalso = url => { googleLlamadas.push(url); return google ? google(url) : { getResponseCode: () => 400, getContentText: () => '{}' }; };
  const ctx = cargarBackend(urlFetchCombinado(bulk, googleFalso), process.env.CODE_GS || null, g.globales);
  return { bulk, g, ctx, googleLlamadas };
}

const b64 = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function jwt(claims, firma) {
  return b64('{"alg":"RS256"}') + '.' + b64(JSON.stringify(claims)) + '.' + (firma || 'firmaFalsaDeGoogleXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
}

module.exports = function (prueba, setGrupo) {
  // ── Import en paralelo ────────────────────────────────────────
  setGrupo('v17 · Import en paralelo (Code.gs real, Bulk API falsa)');
  {
    const { bulk, ctx, g } = montar();
    const rows = filas(500, i => OWNERS[i % 5]);
    const r = ctx.iniciarImportBulk({ sid: 'SID', instanceUrl: INSTANCIA, object: 'Lead', operation: 'insert',
      headers: HEADERS, rows, userEmail: 'edgar.martinez@docplanner.com', clientRequestId: 'req_prueba_0001' });

    prueba('500 filas → 5 jobs de 100', () => {
      assert.strictEqual(r.jobIds.length, 5);
      assert.deepStrictEqual([...r.jobs.map(j => j.filas)], [100, 100, 100, 100, 100]);
      assert.ok(/^lote_[a-f0-9]{16}$/.test(r.loteId), 'loteId: ' + r.loteId);
    });
    prueba('cada owner queda en un solo job', () => {
      const jobsPorOwner = {};
      bulk.jobs.forEach(j => parsearCsv(j.csv).slice(1).forEach(f => {
        (jobsPorOwner[f[4]] = jobsPorOwner[f[4]] || new Set()).add(j.id);
      }));
      Object.entries(jobsPorOwner).forEach(([o, s]) => assert.strictEqual(s.size, 1, o + ' quedó en ' + s.size + ' jobs'));
    });
    prueba('crear, subir y cerrar van en 3 rondas de fetchAll (todas las filas una sola vez)', () => {
      const enviados = bulk.jobs.flatMap(j => parsearCsv(j.csv).slice(1).map(f => f[0]));
      assert.strictEqual(enviados.length, 500);
      assert.strictEqual(new Set(enviados).size, 500);
      assert.ok(bulk.jobs.every(j => j.state === 'UploadComplete'));
    });
    prueba('la auditoría "iniciado" guarda el lote y sus jobIds', () => {
      const fila = g.auditoria.find(f => f[3] === 'iniciado');
      assert.ok(fila && fila[4].includes('lote=' + r.loteId) && fila[4].includes('jobIds=' + r.jobIds.join(',')), fila && fila[4]);
    });
    prueba('doble clic: el mismo clientRequestId no crea otro job', () => {
      const otra = ctx.iniciarImportBulk({ sid: 'SID', instanceUrl: INSTANCIA, object: 'Lead', operation: 'insert',
        headers: HEADERS, rows, userEmail: 'edgar.martinez@docplanner.com', clientRequestId: 'req_prueba_0001' });
      assert.strictEqual(bulk.jobs.length, 5, 'se crearon ' + bulk.jobs.length + ' jobs');
      assert.deepStrictEqual(otra.jobIds, r.jobIds);
      assert.strictEqual(otra.repetido, true);
    });
    prueba('consultarEstadoJob suma los 5 jobs', () => {
      const est = ctx.consultarEstadoJob({ sid: 'SID', instanceUrl: INSTANCIA, jobIds: r.jobIds });
      assert.strictEqual(est.terminado, true);
      assert.strictEqual(est.processed, 500);
      assert.strictEqual(est.jobState, 'JobComplete');
      assert.ok(est.apexProcessingTime > 0 && 'retries' in est && est.totalProcessingTime > 0);
    });
    prueba('recuperar une los CSV con un solo header y 500 filas', () => {
      const res = ctx.recuperarResultadoJob({ sid: 'SID', instanceUrl: INSTANCIA, jobIds: r.jobIds });
      const m = parsearCsv(res.successCsv);
      assert.strictEqual(m.filter(f => f[0] === 'sf__Id').length, 1, 'headers repetidos');
      assert.strictEqual(m.length - 1, 500);
      assert.strictEqual(res.resultsError, '');
      assert.strictEqual(res.stillProcessing, false);
    });
    prueba('recuperar por loteId encuentra los mismos jobs', () => {
      const res = ctx.recuperarResultadoJob({ sid: 'SID', instanceUrl: INSTANCIA, loteId: r.loteId });
      assert.deepStrictEqual(res.jobIds, r.jobIds);
    });
    prueba('recuperar por loteId sin caché lo busca en la auditoría', () => {
      g.cache.delete('lote_' + r.loteId);
      const res = ctx.recuperarResultadoJob({ sid: 'SID', instanceUrl: INSTANCIA, loteId: r.loteId });
      assert.deepStrictEqual(res.jobIds, r.jobIds);
    });
  }
  {
    const { bulk, ctx } = montar();
    const rows = filas(500, i => (i < 300 ? OWNERS[0] : i < 450 ? OWNERS[1] : OWNERS[2]));
    const r = ctx.iniciarImportBulk({ sid: 'SID', instanceUrl: INSTANCIA, headers: HEADERS, rows, object: 'Lead', operation: 'insert' });
    prueba('owners disparejos (300/150/50) → 3 jobs, un owner por job', () => {
      assert.strictEqual(bulk.jobs.length, 3);
      assert.deepStrictEqual([...r.jobs.map(j => j.filas)].sort((a, b) => b - a), [300, 150, 50]);
    });
  }
  {
    const { ctx } = montar();
    const r = ctx.iniciarImportBulk({ sid: 'SID', instanceUrl: INSTANCIA, headers: HEADERS, rows: filas(3000, i => '005' + String(i).padStart(12, '0')), object: 'Lead', operation: 'insert' });
    prueba('3,000 filas → nunca más de 10 jobs', () => assert.strictEqual(r.jobIds.length, 10));
  }
  {
    const { bulk, ctx } = montar({ sondeosParaTerminar: 1 });
    const r = ctx.iniciarImportBulk({ sid: 'SID', instanceUrl: INSTANCIA, headers: HEADERS, rows: filas(200, i => OWNERS[i % 2]), object: 'Lead', operation: 'insert' });
    prueba('mientras un job sigue, terminado = false y recuperar no baja nada', () => {
      const est = ctx.recuperarResultadoJob({ sid: 'SID', instanceUrl: INSTANCIA, jobIds: r.jobIds });
      assert.strictEqual(est.stillProcessing, true);
      assert.strictEqual(est.successCsv, '');
      assert.ok(!bulk.llamadas.some(l => /successfulResults/.test(l)));
    });
  }

  // ── Fallos al iniciar ─────────────────────────────────────────
  setGrupo('v17 · Fallos al iniciar el import');
  {
    const { bulk, ctx } = montar({ falloCrear: [2] });
    let error = null;
    try { ctx.iniciarImportBulk({ sid: 'SID', instanceUrl: INSTANCIA, headers: HEADERS, rows: filas(500, i => OWNERS[i % 5]), object: 'Lead', operation: 'insert' }); }
    catch (e) { error = e; }
    prueba('si un job no se crea, los demás se abortan y no se sube nada', () => {
      assert.ok(error, 'no lanzó error');
      assert.ok(bulk.jobs.every(j => j.state === 'Aborted'), bulk.jobs.map(j => j.state).join(','));
      assert.ok(!bulk.llamadas.some(l => /batches/.test(l)));
    });
  }
  {
    const { bulk, ctx } = montar({ falloSubida: [1] });
    const rows = filas(500, i => OWNERS[i % 5]);
    const r = ctx.iniciarImportBulk({ sid: 'SID', instanceUrl: INSTANCIA, headers: HEADERS, rows, object: 'Lead', operation: 'insert' });
    prueba('si falla la subida de un job: ese se aborta y sus filas vuelven como no enviadas', () => {
      assert.strictEqual(r.jobIds.length, 4);
      assert.strictEqual(r.filasNoEnviadas.length, 100);
      assert.strictEqual(bulk.jobs[1].state, 'Aborted');
      assert.strictEqual(r.total, 400);
      assert.ok(r.errorNoEnviadas);
    });
  }
  {
    const { ctx } = montar({ sesionVencida: true });
    let error = null;
    try { ctx.iniciarImportBulk({ sid: 'SID', instanceUrl: INSTANCIA, headers: HEADERS, rows: filas(10, () => OWNERS[0]), object: 'Lead', operation: 'insert' }); }
    catch (e) { error = e; }
    prueba('SID vencido (401) → error marcado como sesión expirada', () => {
      assert.ok(error && error.sfSesionExpirada === true, error && error.message);
    });
  }

  // ── Resultados ────────────────────────────────────────────────
  setGrupo('v17 · Resultados y reintento por bloqueo');
  {
    const { bulk, ctx, g } = montar({ lock: f => /[05]$/.test(f.Contact__c) });
    const r = ctx.iniciarImportBulk({ sid: 'SID', instanceUrl: INSTANCIA, headers: HEADERS, rows: filas(200, i => OWNERS[i % 2]), object: 'Lead', operation: 'insert' });
    const res = ctx.recuperarResultadoJob({ sid: 'SID', instanceUrl: INSTANCIA, jobIds: r.jobIds, loteId: r.loteId, reintentarLock: true });
    prueba('las filas con UNABLE_TO_LOCK_ROW se reintentan solas en un job extra', () => {
      assert.ok(res.reintentoLock && res.reintentoLock.jobId, 'no hubo reintento');
      assert.strictEqual(res.reintentoLock.filas, 40);
      assert.ok(!/UNABLE_TO_LOCK_ROW/.test(res.failedCsv), 'las filas bloqueadas siguen en failedCsv');
    });
    prueba('el job de reintento crea esas filas y ninguna se duplica', () => {
      const rr = ctx.recuperarResultadoJob({ sid: 'SID', instanceUrl: INSTANCIA, jobIds: [res.reintentoLock.jobId] });
      assert.strictEqual(parsearCsv(rr.successCsv).length - 1, 40);
      const contactos = bulk.creados.map(c => c.fila.Contact__c);
      assert.strictEqual(contactos.length, 200);
      assert.strictEqual(new Set(contactos).size, 200);
    });
    prueba('recuperar otra vez no lanza un segundo reintento', () => {
      const otra = ctx.recuperarResultadoJob({ sid: 'SID', instanceUrl: INSTANCIA, jobIds: r.jobIds, reintentarLock: true });
      assert.strictEqual(otra.reintentoLock.jobId, res.reintentoLock.jobId);
      assert.strictEqual(bulk.jobs.length, 3);
    });
    prueba('recuperar a mano el lote junta el reintento: las filas bloqueadas salen OK, no fallidas', () => {
      const man = ctx.recuperarResultadoJob({ sid: 'SID', instanceUrl: INSTANCIA, loteId: r.loteId });
      assert.strictEqual(man.incluyeReintentoLock, true);
      assert.strictEqual(parsearCsv(man.successCsv).length - 1, 200);
      assert.ok(!/UNABLE_TO_LOCK_ROW/.test(man.failedCsv), 'siguen saliendo como fallidas');
    });
    prueba('lo mismo sin caché (lo encuentra en la auditoría)', () => {
      [...g.cache.keys()].filter(k => k.startsWith('lock_') || k.startsWith('lote_')).forEach(k => g.cache.delete(k));
      const man = ctx.recuperarResultadoJob({ sid: 'SID', instanceUrl: INSTANCIA, jobIds: r.jobIds });
      assert.strictEqual(man.incluyeReintentoLock, true);
      assert.strictEqual(parsearCsv(man.successCsv).length - 1, 200);
    });
  }
  {
    const { ctx } = montar({ falloDescarga: 'failedResults', rechazo: f => (f.LastName === 'Doc3' ? 'REQUIRED_FIELD_MISSING:x:--' : '') });
    const r = ctx.iniciarImportBulk({ sid: 'SID', instanceUrl: INSTANCIA, headers: HEADERS, rows: filas(10, () => OWNERS[0]), object: 'Lead', operation: 'insert' });
    const res = ctx.recuperarResultadoJob({ sid: 'SID', instanceUrl: INSTANCIA, jobIds: r.jobIds });
    prueba('si falla una descarga, devuelve resultsError (no un éxito vacío)', () => {
      assert.ok(res.resultsError && /failedResults/.test(res.resultsError), res.resultsError);
      assert.strictEqual(ctx.estadoAuditoriaRecuperar(res), 'error_resultados');
    });
  }

  // ── Seguridad (doPost) ────────────────────────────────────────
  setGrupo('v17 · Seguridad del backend (doPost)');
  const ahora = Math.floor(Date.now() / 1000);
  const claims = { email: 'edgar.martinez@docplanner.com', hd: 'docplanner.com', exp: ahora + 3000 };
  const tokenBueno = jwt(claims);
  function googleQueSoloAcepta(token, ctxRef) {
    return url => {
      const t = decodeURIComponent(url.split('id_token=')[1] || '');
      if (t !== token) return { getResponseCode: () => 400, getContentText: () => '{"error":"invalid_token"}' };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({
        aud: ctxRef.ctx.GOOGLE_CLIENT_ID, hd: 'docplanner.com', email_verified: 'true', exp: String(claims.exp), email: claims.email }) };
    };
  }
  const post = (ctx, payload) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(payload) } }).contenido);

  {
    const ref = {};
    const m = montar({}, url => googleQueSoloAcepta(tokenBueno, ref)(url));
    ref.ctx = m.ctx;
    const r1 = post(m.ctx, { idToken: tokenBueno, action: 'jobStatus', sid: 'SID', instanceUrl: INSTANCIA, jobId: '750FAKE00000001' });
    prueba('un token válido entra (y se cachea)', () => {
      assert.ok(!r1.authError, JSON.stringify(r1));
      assert.ok([...m.g.cache.keys()].some(k => k.startsWith('tok_')));
    });
    const tokenFalso = jwt({ ...claims, email: 'intruso@docplanner.com' }, tokenBueno.split('.')[2]);
    prueba('token falso con la misma cola que uno cacheado → rechazado', () => {
      assert.strictEqual(tokenFalso.slice(-32), tokenBueno.slice(-32));
      const r = post(m.ctx, { idToken: tokenFalso, action: 'jobStatus', sid: 'SID', instanceUrl: INSTANCIA, jobId: '750FAKE00000001' });
      assert.strictEqual(r.authError, true, JSON.stringify(r));
    });
    prueba('action con "=" no llega como fórmula a la auditoría', () => {
      const antes = m.g.auditoria.length;
      const r = post(m.ctx, { idToken: tokenBueno, action: '=HYPERLINK("http://x","y")' });
      assert.ok(/no válida/.test(r.error), JSON.stringify(r));
      const nuevas = m.g.auditoria.slice(antes);
      assert.ok(nuevas.every(f => f.every(c => typeof c !== 'string' || !/^[=+\-@]/.test(c))), JSON.stringify(nuevas));
      // También con un token rechazado por Google
      const antes2 = m.g.auditoria.length;
      post(m.ctx, { idToken: jwt({ ...claims, email: '=1+1@docplanner.com' }), action: '+cmd' });
      const fila = m.g.auditoria.slice(antes2)[0];
      assert.ok(fila && fila[2] === '(desconocida)', JSON.stringify(fila));
    });
    prueba('instanceUrl ajeno → rechazado sin mandar el SID', () => {
      const llamadasAntes = m.bulk.llamadas.length;
      const r = post(m.ctx, { idToken: tokenBueno, action: 'importStart', sid: 'SID-SECRETO', instanceUrl: 'https://evil.example.com',
        object: 'Lead', operation: 'insert', headers: HEADERS, rows: filas(1, () => OWNERS[0]) });
      assert.ok(/instanceUrl/.test(r.error), JSON.stringify(r));
      assert.strictEqual(m.bulk.llamadas.length, llamadasAntes);
      const r2 = post(m.ctx, { idToken: tokenBueno, action: 'describe', sid: 'SID', instanceUrl: 'https://docplanner.my.salesforce.com.evil.com', object: 'Lead' });
      assert.ok(/instanceUrl/.test(r2.error), JSON.stringify(r2));
    });
    prueba('operation fuera de la lista (delete) y object raro → rechazados', () => {
      const r = post(m.ctx, { idToken: tokenBueno, action: 'importStart', sid: 'SID', instanceUrl: INSTANCIA, object: 'Lead', operation: 'delete', headers: HEADERS, rows: filas(1, () => OWNERS[0]) });
      assert.ok(/no permitida/.test(r.error), JSON.stringify(r));
      const r2 = post(m.ctx, { idToken: tokenBueno, action: 'describe', sid: 'SID', instanceUrl: INSTANCIA, object: 'Lead/../../x' });
      assert.ok(/Objeto/.test(r2.error), JSON.stringify(r2));
    });
    prueba('SID vencido → la respuesta trae sfSessionExpired', () => {
      const m2 = montar({ sesionVencida: true }, url => googleQueSoloAcepta(tokenBueno, ref)(url));
      const r = post(m2.ctx, { idToken: tokenBueno, action: 'jobStatus', sid: 'SID', instanceUrl: INSTANCIA, jobIds: ['750FAKE00000001'] });
      assert.strictEqual(r.sfSessionExpired, true, JSON.stringify(r));
    });
    prueba('baja de usuario: su token cacheado deja de servir', () => {
      m.g.cache.set('whitelist_v15', JSON.stringify(['guilherme.foppa@docplanner.com']));
      const r = post(m.ctx, { idToken: tokenBueno, action: 'jobStatus', sid: 'SID', instanceUrl: INSTANCIA, jobId: '750FAKE00000001' });
      assert.strictEqual(r.notAuthorized, true, JSON.stringify(r));
      m.g.cache.delete('whitelist_v15');
    });
  }
  {
    const m = montar();
    prueba('token basura → rechazado sin llamar a Google ni auditar', () => {
      const r = post(m.ctx, { idToken: 'esto-no-es-un-jwt', action: 'describe' });
      assert.strictEqual(r.authError, true);
      assert.strictEqual(m.googleLlamadas.length, 0);
      assert.strictEqual(m.g.auditoria.length, 0);
    });
  }

  // ── Asignación (P2) ───────────────────────────────────────────
  setGrupo('v17 · Asignación: IDs, reps y errores de Salesforce');
  {
    const sf = SF.crearSalesforceFalso();
    const ctx = cargarBackend(sf.UrlFetchApp);
    const base = { sid: 'SID', instanceUrl: INSTANCIA, dias: 0, businessLine: 'Agenda Premium', leadType: 'New Business',
      extraFields: [], fieldsFromSF: [], camposFijosOcultos: [], fieldsManualValues: {} };
    const res = ctx.procesarAsignacion(Object.assign({}, base, {
      reps: [{ email: 'rep.a@test.local', cuota: 5 }, { email: 'REP.A@test.local', cuota: 50 }, { email: 'rep.b@test.local', cuota: 5 }],
      ids: ['003TEST00000001', 'basura con espacios', "003TEST00000002' OR Id != '", '003TEST00000003', '003TEST00000001']
    }));
    prueba('IDs inválidos se reportan y no tumban su bloque', () => {
      assert.strictEqual(res.idsInvalidos.length, 2);
      assert.strictEqual(res.bloquesFallidos, 0);
      assert.strictEqual(res.poolTotal, 2);
      assert.strictEqual(res.idsRepetidos, 1);
    });
    prueba('un rep repetido cuenta una vez (gana la primera cuota)', () => {
      assert.deepStrictEqual([...res.repsRepetidos], ['rep.a@test.local']);
      assert.strictEqual(res.ownerStats.length, 2);
    });
    prueba('días fuera de rango → error claro', () => {
      assert.throws(() => ctx.procesarAsignacion(Object.assign({}, base, { dias: -5, reps: [{ email: 'rep.a@test.local', cuota: 1 }], ids: ['003TEST00000001'] })), /Días/);
    });
    prueba('un bloque con HTTP 500 cuenta como fallido (antes se tragaba)', () => {
      const sf2 = SF.crearSalesforceFalso();
      const original = sf2.UrlFetchApp.fetch;
      sf2.UrlFetchApp.fetch = (url, o) => (/FROM\+Contact|FROM%20Contact/.test(url)
        ? { getResponseCode: () => 500, getContentText: () => '[{"errorCode":"QUERY_TIMEOUT"}]' } : original(url, o));
      const ctx2 = cargarBackend(sf2.UrlFetchApp);
      const r = ctx2.procesarAsignacion(Object.assign({}, base, { reps: [{ email: 'rep.a@test.local', cuota: 5 }], ids: ['003TEST00000001'] }));
      assert.strictEqual(r.bloquesFallidos, 1);
      assert.ok(/QUERY_TIMEOUT/.test(r.mensaje), r.mensaje);
    });
  }
};
