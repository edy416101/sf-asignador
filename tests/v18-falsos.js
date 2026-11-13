// v18 · Falsos más fieles y pruebas de lo que no tenía ninguna: doGet, rate limit, cada rama de
// validarIdToken, exportes a Sheets y panel admin. Todo pasa por doPost real cuando se puede.
// Nada sale a la red: Google, Drive, Sheets y Salesforce son objetos en memoria.
const assert = require('assert');
const { cargarBackend, serviciosGoogleFalsos } = require('./lib/cargar');
const { crearBulkFalso, parsearCsv } = require('./lib/bulk-falso');
const { urlFetchFiel, respuesta } = require('./lib/google-falso');
const SF = require('./lib/sf-falso');

const INSTANCIA = 'https://docplanner.my.salesforce.com';
const USUARIO = 'usuario.prueba@docplanner.com';
const ADMIN = 'admin.prueba@docplanner.com';
const b64 = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let nToken = 0;
const jwt = claims => b64('{"alg":"RS256"}') + '.' + b64(JSON.stringify(claims)) + '.firma' + (++nToken) + 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

// Backend completo: Salesforce + Bulk + Google falsos detrás de un solo UrlFetchApp que truena como el real.
function montar({ google = {}, bulk = {}, sf = {} } = {}) {
  const g = serviciosGoogleFalsos(google);
  const b = crearBulkFalso(bulk);
  const s = SF.crearSalesforceFalso(sf);
  const gf = urlFetchFiel(g.google);
  const destino = url => (/googleapis\.com/.test(url) ? gf : /\/jobs\/ingest/.test(url) ? b.UrlFetchApp : s.UrlFetchApp);
  const UrlFetchApp = {
    fetch: (url, o) => destino(url).fetch(url, o),
    fetchAll: reqs => reqs.map(r => destino(r.url).fetch(r.url, r))
  };
  const ctx = cargarBackend(UrlFetchApp, process.env.CODE_GS || null, g.globales);
  // Un token válido para `email`, registrado en el tokeninfo falso (o con `info` a la medida)
  const token = (email = USUARIO, info = {}, claims = {}) => {
    const exp = Math.floor(Date.now() / 1000) + 3000;
    const t = jwt(Object.assign({ email, hd: 'docplanner.com', exp }, claims));
    g.registrarToken(t, Object.assign({ aud: ctx.GOOGLE_CLIENT_ID, hd: 'docplanner.com', email_verified: 'true', exp: String(exp), email }, info));
    return t;
  };
  const post = payload => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(payload) } }).getContent());
  return { g, b, s, ctx, token, post };
}

module.exports = function (prueba, setGrupo) {
  // ── Los falsos se portan como los reales ───────────────────────
  setGrupo('v18 · Falsos fieles (Cache, Lock, UrlFetchApp, Bulk API, Salesforce)');
  prueba('CacheService: el valor vence a su TTL y nunca dura más de 6 h', () => {
    const g = serviciosGoogleFalsos();
    const c = g.globales.CacheService.getScriptCache();
    c.put('a', 'x', 60); c.put('b', 'y', 999999);
    g.avanzar(59000); assert.strictEqual(c.get('a'), 'x');
    g.avanzar(2000); assert.strictEqual(c.get('a'), null);
    g.avanzar(21600 * 1000); assert.strictEqual(c.get('b'), null);
  });
  prueba('CacheService: más de 100 KB o llave de más de 250 caracteres → truena como el real', () => {
    const c = serviciosGoogleFalsos().globales.CacheService.getScriptCache();
    assert.throws(() => c.put('k', 'x'.repeat(100 * 1024 + 1)), /too large: value/);
    assert.throws(() => c.put('k'.repeat(251), 'x'), /too large: key/);
    c.put('k', 'x'.repeat(100 * 1024));
  });
  prueba('LockService ocupado: tryLock da false y waitLock truena', () => {
    const g = serviciosGoogleFalsos({ lockOcupado: true });
    const l = g.globales.LockService.getScriptLock();
    assert.strictEqual(l.tryLock(1000), false);
    assert.throws(() => l.waitLock(1000), /Lock timeout/);
    g.opciones.lockOcupado = false;
    assert.strictEqual(l.tryLock(1000), true);
  });
  prueba('UrlFetchApp: 4xx/5xx truenan sin muteHttpExceptions y las URLs de más de 2048 caracteres también', () => {
    const f = urlFetchFiel(() => respuesta(500, 'falla'));
    assert.throws(() => f.fetch('https://x.invalid/a'), /returned code 500/);
    assert.strictEqual(f.fetch('https://x.invalid/a', { muteHttpExceptions: true }).getResponseCode(), 500);
    const ok = urlFetchFiel(() => respuesta(200, 'ok'));
    assert.throws(() => ok.fetch('https://x.invalid/?q=' + 'a'.repeat(2048), { muteHttpExceptions: true }), /URL Length/);
  });
  prueba('fetchAll: si una petición truena, las demás sí llegaron y la excepción sale al final', () => {
    const vistas = [];
    const f = urlFetchFiel(u => { vistas.push(u); if (/2$/.test(u)) throw new Error('Address unavailable'); return respuesta(200, ''); });
    assert.throws(() => f.fetchAll(['https://x.invalid/1', 'https://x.invalid/2', 'https://x.invalid/3'].map(url => ({ url }))), /Address unavailable/);
    assert.strictEqual(vistas.length, 3);
  });
  {
    const b = crearBulkFalso({ falloJob: j => (j.i === 1 ? { mensaje: 'InvalidBatch : Field name not found : Foo__c', procesadas: 1 } : '') });
    const F = b.UrlFetchApp;
    const base = INSTANCIA + '/services/data/v62.0/jobs/ingest';
    const crear = () => JSON.parse(F.fetch(base, { method: 'post', payload: JSON.stringify({ object: 'Lead', operation: 'insert' }), muteHttpExceptions: true }).getContentText()).id;
    const subir = (id, csv) => F.fetch(base + '/' + id + '/batches', { method: 'put', payload: csv, muteHttpExceptions: true }).getResponseCode();
    const estado = (id, st) => F.fetch(base + '/' + id, { method: 'patch', payload: JSON.stringify({ state: st }), muteHttpExceptions: true });
    const j0 = crear(), j1 = crear();
    subir(j0, '"Contact__c","LastName"\n"003A","A"\n'); subir(j1, '"Contact__c","LastName"\n"003B","B"\n"003C","C"\n');
    prueba('Bulk falsa: Job IDs y Lead IDs de 18 caracteres', () => {
      assert.ok(/^750\w{15}$/.test(j0), j0);
      estado(j0, 'UploadComplete');
      assert.ok(b.creados.every(c => /^00Q\w{15}$/.test(c.id)));
    });
    prueba('Bulk falsa: cerrar dos veces → 400 INVALIDJOBSTATE; abortar no deshace lo ya creado', () => {
      const r = estado(j0, 'UploadComplete');
      assert.strictEqual(r.getResponseCode(), 400);
      assert.ok(/INVALIDJOBSTATE/.test(r.getContentText()));
      assert.strictEqual(estado(j0, 'Aborted').getResponseCode(), 200);
      assert.strictEqual(b.creados.length, 1);
      assert.strictEqual(estado(j0, 'Aborted').getResponseCode(), 400);
    });
    prueba('Bulk falsa: un job Failed trae errorMessage y sus filas sin procesar en unprocessedrecords', () => {
      estado(j1, 'UploadComplete');
      const d = JSON.parse(F.fetch(base + '/' + j1, { muteHttpExceptions: true }).getContentText());
      assert.strictEqual(d.state, 'Failed');
      assert.ok(/Field name not found/.test(d.errorMessage));
      const sin = parsearCsv(F.fetch(base + '/' + j1 + '/unprocessedrecords', { muteHttpExceptions: true }).getContentText());
      assert.deepStrictEqual(sin.slice(1), [['003C', 'C']]);
    });
  }
  prueba('Bulk falsa: upsert con External ID repetido actualiza (sf__Created=false)', () => {
    const b = crearBulkFalso();
    const base = INSTANCIA + '/services/data/v62.0/jobs/ingest';
    const corre = () => {
      const id = JSON.parse(b.UrlFetchApp.fetch(base, { method: 'post', payload: JSON.stringify({ object: 'Lead', operation: 'upsert', externalIdFieldName: 'Contact__c' }) }).getContentText()).id;
      b.UrlFetchApp.fetch(base + '/' + id + '/batches', { method: 'put', payload: '"Contact__c","LastName"\n"003A","A"\n' });
      b.UrlFetchApp.fetch(base + '/' + id, { method: 'patch', payload: '{"state":"UploadComplete"}' });
      return parsearCsv(b.UrlFetchApp.fetch(base + '/' + id + '/successfulResults').getContentText())[1];
    };
    assert.strictEqual(corre()[1], 'true');
    assert.strictEqual(corre()[1], 'false');
    assert.strictEqual(b.creados.length, 1);
  });
  prueba('Bulk falsa: excepción "despues" → Salesforce hizo el cambio aunque la respuesta se perdió', () => {
    const b = crearBulkFalso({ excepcion: p => (p.paso === 'cerrar' ? 'despues' : '') });
    const base = INSTANCIA + '/services/data/v62.0/jobs/ingest';
    const id = JSON.parse(b.UrlFetchApp.fetch(base, { method: 'post', payload: '{"object":"Lead","operation":"insert"}' }).getContentText()).id;
    b.UrlFetchApp.fetch(base + '/' + id + '/batches', { method: 'put', payload: '"Contact__c"\n"003A"\n' });
    assert.throws(() => b.UrlFetchApp.fetch(base + '/' + id, { method: 'patch', payload: '{"state":"UploadComplete"}', muteHttpExceptions: true }), /Timeout/);
    assert.strictEqual(b.creados.length, 1);
  });
  prueba('Bulk falsa: bloqueo envuelto en el error de un trigger', () => {
    const b = crearBulkFalso({ lock: () => true, lockEnvuelto: true });
    assert.ok(/^CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY:.*UNABLE_TO_LOCK_ROW/.test(b.ERROR_LOCK_ENVUELTO));
  });
  prueba('Salesforce falso: describe con tipos y picklists, 401 y done:false', () => {
    const s = SF.crearSalesforceFalso({ tamPagina: 2 });
    const d = JSON.parse(s.UrlFetchApp.fetch(INSTANCIA + '/services/data/v62.0/sobjects/Lead/describe', { muteHttpExceptions: true }).getContentText());
    const pais = d.fields.find(f => f.name === 'Country__c');
    assert.strictEqual(pais.type, 'picklist');
    assert.ok(pais.picklistValues.some(p => p.value === 'Peru'));
    const soql = "SELECT Id FROM Contact WHERE Id IN ('003TEST00000001','003TEST00000002','003TEST00000003')";
    const q = JSON.parse(s.UrlFetchApp.fetch(INSTANCIA + '/services/data/v62.0/query/?q=' + encodeURIComponent(soql), { muteHttpExceptions: true }).getContentText());
    assert.strictEqual(q.done, false);
    assert.strictEqual(q.records.length, 2);
    const s2 = SF.crearSalesforceFalso({ sesionVencida: true });
    assert.strictEqual(s2.UrlFetchApp.fetch(INSTANCIA + '/x', { muteHttpExceptions: true }).getResponseCode(), 401);
  });

  // ── doGet y doPost ─────────────────────────────────────────────
  setGrupo('v18 · doGet, rate limit y auditoría (doPost real)');
  prueba('doGet responde OK y la versión del backend', () => {
    const { ctx } = montar();
    const r = JSON.parse(ctx.doGet({}).getContent());
    assert.deepStrictEqual(r, { status: 'OK', version: ctx.VERSION_BACKEND });
  });
  {
    const m = montar();
    const t = m.token();
    const describe = () => m.post({ idToken: t, action: 'describe', sid: 'SID', instanceUrl: INSTANCIA, object: 'Lead' });
    const r1 = describe();
    prueba('describe por doPost trae fields y fieldsMetadata con picklists', () => {
      assert.ok(r1.fields.includes('Country__c'), JSON.stringify(r1).slice(0, 200));
      assert.ok(r1.fieldsMetadata.Status.picklistValues.includes('Assigned'));
      assert.ok(!r1.fieldsMetadata.Status.picklistValues.includes('Viejo'), 'un valor inactivo no debe salir');
    });
    prueba('rate limit: la operación 101 de la hora se rechaza y queda en la auditoría', () => {
      for (let i = 1; i < 100; i++) assert.ok(!describe().rateLimited, 'cortó antes en ' + i);
      const r = describe();
      assert.strictEqual(r.rateLimited, true);
      assert.ok(r.resetEnMinutos >= 1 && r.resetEnMinutos <= 60);
      assert.ok(m.g.auditoria.some(f => f[3] === 'rate_limited' && f[1] === USUARIO));
    });
    prueba('rate limit: jobStatus no cuenta (el sondeo de un import largo no se corta)', () => {
      const r = m.post({ idToken: t, action: 'jobStatus', sid: 'SID', instanceUrl: INSTANCIA, jobIds: ['750FAKE00000001AAA'] });
      assert.ok(!r.rateLimited, JSON.stringify(r));
    });
    prueba('rate limit: el contador es por usuario', () => {
      const r = m.post({ idToken: m.token(ADMIN), action: 'describe', sid: 'SID', instanceUrl: INSTANCIA, object: 'Lead' });
      assert.ok(!r.rateLimited && r.fields, JSON.stringify(r).slice(0, 200));
    });
  }
  {
    const m = montar();
    prueba('acción desconocida → "Acción no válida" y cuenta para el rate limit', () => {
      const r = m.post({ idToken: m.token(), action: 'borrarTodo' });
      assert.ok(/no válida/.test(r.error), JSON.stringify(r));
      assert.ok([...m.g.cache.keys()].some(k => k.startsWith('rate_' + USUARIO)));
    });
    prueba('cuerpo que no es JSON u objeto → error, sin tronar el backend', () => {
      const r1 = JSON.parse(m.ctx.doPost({ postData: { contents: 'no es json' } }).getContent());
      const r2 = JSON.parse(m.ctx.doPost({ postData: { contents: '[1,2]' } }).getContent());
      assert.ok(r1.error && r2.error);
    });
  }

  // ── validarIdToken: cada rama ──────────────────────────────────
  setGrupo('v18 · Login de Google: cada rama de validarIdToken');
  {
    const m = montar();
    const ahora = Math.floor(Date.now() / 1000);
    const casos = [
      ['sin token', () => undefined, /No se envió/, { basura: true }],
      ['token de más de 4 KB', () => 'a.' + 'b'.repeat(4100) + '.c', /formato/, { basura: true }],
      ['JWT sin exp', () => jwt({ email: USUARIO }), /formato/, { basura: true }],
      ['exp vencido (sin preguntar a Google)', () => jwt({ email: USUARIO, exp: ahora - 10 }), /expirada/, {}],
      ['Google lo rechaza (400)', () => jwt({ email: USUARIO, exp: ahora + 100 }), /HTTP 400/, {}],
      ['emitido para otra app (aud)', () => m.token(USUARIO, { aud: 'otra-app.apps.googleusercontent.com' }), /otra aplicación/, {}],
      ['dominio ajeno (hd)', () => m.token(USUARIO, { hd: 'gmail.com' }), /Dominio no autorizado/, {}],
      ['email no verificado', () => m.token(USUARIO, { email_verified: 'false' }), /no verificado/, {}],
      ['exp de Google vencido', () => m.token(USUARIO, { exp: String(ahora - 5) }), /expirada/, {}],
      ['fuera de la whitelist', () => m.token('intruso@docplanner.com'), /no está autorizado/, { notAuthorized: true }]
    ];
    casos.forEach(([nombre, tok, re, extra]) => {
      prueba(nombre + ' → rechazado', () => {
        const t = tok();
        const v = m.ctx.validarIdToken(t);
        assert.strictEqual(v.valid, false);
        assert.ok(re.test(v.error), v.error);
        if (extra.basura) assert.strictEqual(v.basura, true);
        if (extra.notAuthorized) assert.strictEqual(v.notAuthorized, true);
        const r = m.post({ idToken: t, action: 'describe' });
        assert.strictEqual(r.authError, true);
        if (extra.notAuthorized) assert.strictEqual(r.notAuthorized, true);
      });
    });
    prueba('token válido → entra, se cachea y la segunda vez no pregunta a Google', () => {
      const t = m.token();
      assert.deepStrictEqual({ ...m.ctx.validarIdToken(t) }, { valid: true, email: USUARIO });
      m.g.tokens.delete(t);   // si volviera a preguntar a Google, ahora lo rechazaría
      assert.strictEqual(m.ctx.validarIdToken(t).valid, true);
    });
    prueba('el caché del token vence a los 5 min (después vuelve a preguntar)', () => {
      const t = m.token();
      assert.strictEqual(m.ctx.validarIdToken(t).valid, true);
      m.g.tokens.delete(t);
      m.g.avanzar(301000);
      assert.strictEqual(m.ctx.validarIdToken(t).valid, false);
    });
  }

  // ── Exportes ───────────────────────────────────────────────────
  setGrupo('v18 · Exportes a Google Sheets (Drive falso)');
  const datosExport = {
    summary: { ownerStats: [{ email: 'rep.a@test.local', count: 2 }], contactosAsignados: 2, repsActivos: 1, contactosQueryPass: 2,
      meta: { fecha: '2026-11-13', businessLine: 'Agenda Premium', dias: 0 } },
    preTemplateHeaders: ['Contact__c', 'LastName', 'Company'],
    preTemplateRows: [['003A', 'Pérez', '=HYPERLINK("http://x","y")'], ['003B', 'López', 'Clinica']],
    importResultHeaders: ['Contact__c', '__Status'], importResultRows: [['003A', 'Succeeded']]
  };
  {
    const m = montar();
    const r = m.post(Object.assign({ idToken: m.token(), action: 'exportSheet', fileName: 'Export prueba' }, datosExport));
    const ss = m.g.spreadsheets.get(r.id);
    prueba('Sheet nuevo: 3 hojas, sin "Hoja 1", en la carpeta COE y del usuario', () => {
      assert.ok(ss, JSON.stringify(r));
      assert.deepStrictEqual(ss.getSheets().map(h => h.getName()), ['Summary', 'Pre Template', 'Import Result']);
      assert.strictEqual(r.folderMoved, true);
      assert.deepStrictEqual(m.g.archivos.get(r.id).padres, ['carpeta_prueba']);
      assert.strictEqual(r.ownershipTransferred, true);
      assert.strictEqual(m.g.archivos.get(r.id).owner, USUARIO);
    });
    prueba('un valor que empieza con "=" se escribe como texto (no como fórmula)', () => {
      const celda = ss.getSheetByName('Pre Template').getRange(2, 3).getValue();
      assert.strictEqual(celda, '\'=HYPERLINK("http://x","y")');
    });
    prueba('Summary: owners, totales y la fórmula TOTAL', () => {
      const v = ss.getSheetByName('Summary').getRange(1, 1, 12, 6).getValues().flat();
      assert.ok(v.includes('rep.a@test.local') && v.includes(USUARIO) && v.some(x => /^=SUM\(B\d+:B\d+\)$/.test(x)), JSON.stringify(v));
    });
  }
  {
    const m = montar();
    m.g.agregarSheet({ id: 'sheetDeOtro_0000000000000', owner: 'otra.persona@docplanner.com' });
    m.g.agregarSheet({ id: 'sheetMio_00000000000000000', owner: 'otra.persona@docplanner.com', editores: [USUARIO] });
    const exp = url => m.post(Object.assign({ idToken: m.token(), action: 'exportSheet', targetSheetUrl: url }, datosExport));
    prueba('adjuntar a un Sheet donde el usuario no es editor → rechazado (aunque el script lo vea)', () => {
      assert.ok(/Solo puedes adjuntar/.test(exp('https://docs.google.com/spreadsheets/d/sheetDeOtro_0000000000000/edit').error));
    });
    prueba('adjuntar al Sheet de auditoría → rechazado', () => {
      assert.ok(/no se puede usar/.test(exp('https://docs.google.com/spreadsheets/d/sheet_prueba/edit').error));
    });
    prueba('adjuntar a un Sheet donde el usuario es editor → agrega las 3 hojas', () => {
      const r = exp('https://docs.google.com/spreadsheets/d/sheetMio_00000000000000000/edit');
      assert.strictEqual(r.mode, 'attached', JSON.stringify(r));
      assert.deepStrictEqual(m.g.spreadsheets.get('sheetMio_00000000000000000').getSheets().map(h => h.getName()), ['Hoja 1', 'Summary', 'Pre Template', 'Import Result']);
    });
  }
  {
    const m = montar();
    const csv = 'Contact__c,LastName\n003A,"=1+1"\n';
    const r = m.post(Object.assign({ idToken: m.token(), action: 'exportSheetFromFile', fileName: 'Desde CSV', fileContent: Buffer.from(csv).toString('base64'),
      fileMimeType: 'text/csv', origFileName: 'datos.csv' }, datosExport));
    prueba('desde CSV: hoja "Received Data" neutralizada + 3 hojas, y el archivo temporal a la papelera', () => {
      const ss = m.g.spreadsheets.get(r.id);
      assert.ok(ss, JSON.stringify(r));
      assert.deepStrictEqual(ss.getSheets().map(h => h.getName()), ['Received Data', 'Summary', 'Pre Template', 'Import Result']);
      assert.strictEqual(ss.getSheetByName('Received Data').getRange(2, 2).getValue(), "'=1+1");
      const temporales = [...m.g.archivos.values()].filter(a => /^file_/.test(a.id));
      assert.ok(temporales.length === 1 && temporales[0].trashed);
    });
    const r2 = m.post(Object.assign({ idToken: m.token(), action: 'exportSheetFromFile', fileName: 'Desde Excel', fileContent: Buffer.from(csv).toString('base64'),
      fileMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', origFileName: 'datos.xlsx' }, datosExport));
    prueba('desde Excel: se convierte con Drive (falso) y quedan sus datos + 3 hojas', () => {
      const ss = m.g.spreadsheets.get(r2.id);
      assert.ok(ss, JSON.stringify(r2));
      assert.deepStrictEqual(ss.getSheets().map(h => h.getName()), ['Hoja 1', 'Summary', 'Pre Template', 'Import Result']);
    });
  }

  // ── Panel admin ────────────────────────────────────────────────
  setGrupo('v18 · Panel admin (doPost real, Sheet falso)');
  {
    const m = montar();
    const tU = m.token(USUARIO), tA = m.token(ADMIN);
    prueba('la pestaña Usuarios se crea y se siembra sola con ALLOWED_EMAILS', () => {
      const d = m.post({ idToken: tU, action: 'adminData' });
      assert.strictEqual(d.esAdmin, false, JSON.stringify(d).slice(0, 300));
      assert.ok(m.g.hoja(null, 'Usuarios'));
      assert.ok(d.usuarios.some(u => u.email === USUARIO));
      assert.strictEqual(d.health.sheetEscritura, true);
      assert.strictEqual(d.health.carpetaCOE, 'COE Exports');
    });
    prueba('un usuario normal no puede dar altas ni bajas', () => {
      assert.ok(/administradores/.test(m.post({ idToken: tU, action: 'adminAddUser', email: 'nuevo@docplanner.com' }).error));
      assert.ok(/administradores/.test(m.post({ idToken: tU, action: 'adminRemoveUser', email: USUARIO }).error));
    });
    prueba('alta: solo @docplanner.com, sin repetidos, y entra al momento', () => {
      assert.ok(/docplanner\.com/.test(m.post({ idToken: tA, action: 'adminAddUser', email: 'alguien@gmail.com' }).error));
      assert.strictEqual(m.post({ idToken: tA, action: 'adminAddUser', email: 'Nuevo.Rep@docplanner.com' }).ok, true);
      assert.ok(/ya tiene acceso/.test(m.post({ idToken: tA, action: 'adminAddUser', email: 'nuevo.rep@docplanner.com' }).error));
      assert.strictEqual(m.ctx.validarIdToken(m.token('nuevo.rep@docplanner.com')).valid, true);
    });
    prueba('baja: no se puede quitar a un admin; la baja corta el acceso al momento', () => {
      assert.ok(/administrador/.test(m.post({ idToken: tA, action: 'adminRemoveUser', email: ADMIN }).error));
      const tN = m.token('nuevo.rep@docplanner.com');
      assert.strictEqual(m.ctx.validarIdToken(tN).valid, true);
      assert.strictEqual(m.post({ idToken: tA, action: 'adminRemoveUser', email: 'nuevo.rep@docplanner.com' }).ok, true);
      assert.strictEqual(m.post({ idToken: tN, action: 'adminData' }).notAuthorized, true);
    });
    prueba('alta con el candado ocupado → error claro, sin escribir', () => {
      const filas = m.g.hoja(null, 'Usuarios').getLastRow();
      m.g.opciones.lockOcupado = true;
      const r = m.post({ idToken: tA, action: 'adminAddUser', email: 'otro@docplanner.com' });
      m.g.opciones.lockOcupado = false;
      assert.ok(/Intenta en unos segundos|ocupado/.test(r.error), JSON.stringify(r));
      assert.strictEqual(m.g.hoja(null, 'Usuarios').getLastRow(), filas);
    });
  }
  {
    const m = montar();
    const tA = m.token(ADMIN);
    const ahora = new Date();
    const hoja = m.g.spreadsheets.get('sheet_prueba').getSheets()[0];
    hoja.appendRow(['Timestamp', 'Email', 'Operación', 'Estado', 'Detalles']);
    hoja.appendRow([ahora, USUARIO, 'import', 'iniciado', 'jobId=750FAKE00000001AAA; lote=lote_aaaaaaaaaaaaaaaa; jobIds=750FAKE00000001AAA']);
    hoja.appendRow([ahora, USUARIO, 'import', 'success', 'jobId=750FAKE00000001AAA; lote=lote_aaaaaaaaaaaaaaaa; state=JobComplete; processed=50; failed=2']);
    hoja.appendRow([ahora, USUARIO, 'import', 'iniciado', 'jobId=750FAKE00000002AAA; lote=lote_bbbbbbbbbbbbbbbb; jobIds=750FAKE00000002AAA']);
    hoja.appendRow([ahora, 'x@docplanner.com', 'describe', 'no_autorizado', 'Tu email no está autorizado']);
    const d = m.post({ idToken: tA, action: 'adminData' });
    prueba('métricas: un import exitoso con sus procesados y fallidos', () => {
      assert.strictEqual(d.metricas.totImports, 1, JSON.stringify(d.metricas));
      assert.strictEqual(d.metricas.totProcesados, 50);
      assert.strictEqual(d.metricas.totFallidos, 2);
    });
    prueba('huérfanos: el lote iniciado sin cierre aparece; el cerrado no', () => {
      assert.deepStrictEqual(d.huerfanos.map(h => h.loteId), ['lote_bbbbbbbbbbbbbbbb']);
    });
    prueba('accesos negados en su lista', () => {
      assert.ok(d.negados.some(n => n.email === 'x@docplanner.com' && n.estado === 'no_autorizado'));
    });
  }
};
