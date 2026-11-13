// v18.3 · Asignación, exportes y backend P2 (Code.gs real, Salesforce/Bulk/Google falsos, sin red).
const assert = require('assert');
const { cargarBackend, serviciosGoogleFalsos, cargarFunciones } = require('./lib/cargar');
const { crearBulkFalso } = require('./lib/bulk-falso');
const { urlFetchFiel } = require('./lib/google-falso');
const SF = require('./lib/sf-falso');

const INSTANCIA = 'https://docplanner.my.salesforce.com';
const USUARIO = 'usuario.prueba@docplanner.com';
const BASE_ASIG = { sid: 'SID', instanceUrl: INSTANCIA, dias: 0, businessLine: 'Agenda Premium', leadType: 'New Business',
  extraFields: [], fieldsFromSF: [], camposFijosOcultos: [], fieldsManualValues: {} };
const ids = n => Array.from({ length: n }, (_, i) => '003TEST' + String(i).padStart(8, '0'));

function montar({ sf = {}, bulk = {}, google = {} } = {}) {
  const g = serviciosGoogleFalsos(google);
  const b = crearBulkFalso(bulk);
  const s = SF.crearSalesforceFalso(sf);
  const gf = urlFetchFiel(g.google);
  const destino = url => (/googleapis\.com/.test(url) ? gf : /\/jobs\/ingest/.test(url) ? b.UrlFetchApp : s.UrlFetchApp);
  const ctx = cargarBackend({ fetch: (u, o) => destino(u).fetch(u, o), fetchAll: r => r.map(x => destino(x.url).fetch(x.url, x)) },
    process.env.CODE_GS || null, g.globales);
  const token = (email = USUARIO) => {
    const exp = Math.floor(Date.now() / 1000) + 3000;
    const t = ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify({ email, exp, aud: ctx.GOOGLE_CLIENT_ID, iss: 'accounts.google.com' })).toString('base64url'), 'f' + Math.random().toString(36).slice(2) + 'XXXXXXXXXXXXXXXXXXXXXX'].join('.');
    g.registrarToken(t, { aud: ctx.GOOGLE_CLIENT_ID, hd: 'docplanner.com', email_verified: 'true', exp: String(exp), email });
    return t;
  };
  const post = p => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(p) } }).getContent());
  return { g, b, s, ctx, token, post };
}

module.exports = function (html, prueba, setGrupo) {
  setGrupo('v18.3 · Asignación: reps y queries que caben en la URL');
  {
    const usuarios = {};
    for (let i = 0; i < 24; i++) usuarios['representante.comercial.numero' + String(i).padStart(2, '0') + '@docplanner.com'] = '005P4000000' + String(i).padStart(4, '0') + 'AAA';
    const m = montar({ sf: { usuarios } });
    let res = null, error = null;
    try { res = m.ctx.procesarAsignacion(Object.assign({}, BASE_ASIG, { reps: Object.keys(usuarios).map(email => ({ email, cuota: 3 })), ids: ids(80) })); }
    catch (e) { error = e; }
    prueba('24 reps con correos largos: la query de Users no pasa de 2 kB y se encuentran todos', () => {
      assert.ok(!error, error && error.message);
      assert.strictEqual(res.ownersNotFound.length, 0);
      assert.strictEqual(res.ownerStats.filter(o => o.count === 3).length, 24);
      assert.ok(m.s.urls.every(u => u.length <= 2048));
    });
  }
  {
    const extraFields = Array.from({ length: 14 }, (_, i) => ({ name: 'Campo_Personalizado_Muy_Largo_Del_Contacto_Numero_' + i + '__c', mode: 'sf' }));
    const m = montar();
    const res = m.ctx.procesarAsignacion(Object.assign({}, BASE_ASIG, { extraFields, reps: [{ email: 'rep.a@test.local', cuota: 200 }], ids: ids(100) }));
    prueba('con 14 campos custom largos en el SELECT, ningún bloque de contactos falla (caben menos IDs por query)', () => {
      assert.strictEqual(res.bloquesFallidos, 0, res.mensaje);
      assert.strictEqual(res.poolTotal, 99);   // 100 menos el que tiene opp abierta
      assert.ok(m.s.urls.every(u => u.length <= 2000), Math.max(...m.s.urls.map(u => u.length)) + ' caracteres');
    });
  }
  {
    const m = montar({ sf: { usuarios: {}, usuariosExtra: [
      { Id: '005P400000USERNAME', Email: 'otra.persona@docplanner.com', Username: 'ana@docplanner.com' },
      { Id: '005P400000PORMAIL1', Email: 'ana@docplanner.com', Username: 'ana@docplanner.com.sales' },
      { Id: '005P400000DOBLE001', Email: 'doble@docplanner.com', Username: 'doble.1@docplanner.com' },
      { Id: '005P400000DOBLE002', Email: 'doble@docplanner.com', Username: 'doble.2@docplanner.com' }
    ] } });
    const res = m.ctx.procesarAsignacion(Object.assign({}, BASE_ASIG, { reps: [{ email: 'ana@docplanner.com', cuota: 2 }, { email: 'doble@docplanner.com', cuota: 2 }], ids: ids(10) }));
    const stat = e => res.ownerStats.find(o => o.email === e);
    prueba('OwnerId: el Username manda sobre el Email', () => {
      assert.strictEqual(stat('ana@docplanner.com').ownerId, '005P400000USERNAME');
    });
    prueba('un Email con 2 usuarios activos no se asigna y se avisa', () => {
      assert.strictEqual(stat('doble@docplanner.com').count, 0);
      assert.strictEqual((res.repsAmbiguos || []).length, 1, JSON.stringify(res.repsAmbiguos));
      assert.ok(/2 o más usuarios/.test(res.mensaje), res.mensaje);
    });
  }

  setGrupo('v18.3 · Estado y conteos de los jobs');
  {
    const m = montar({ bulk: { sondeosParaTerminar: 1 } });
    const rows = Array.from({ length: 100 }, (_, i) => ['003EST' + String(i).padStart(9, '0'), 'C', 'D' + i, 'd@t.mx', i < 50 ? '005P400000FpACnIAN' : '005P400000Fp9aHIAR']);
    const r = m.ctx.iniciarImportBulk({ sid: 'SID', instanceUrl: INSTANCIA, object: 'Lead', operation: 'insert', userEmail: USUARIO,
      headers: ['Contact__c', 'Company', 'LastName', 'Email', 'OwnerId'], rows, clientRequestId: 'req_estado_0001' });
    const base = INSTANCIA + '/services/data/v62.0/jobs/ingest/';
    m.b.UrlFetchApp.fetch(base + r.jobIds[0], { muteHttpExceptions: true });
    m.b.UrlFetchApp.fetch(base + r.jobIds[0], { muteHttpExceptions: true });   // el primero ya terminó, el segundo no
    const est = m.ctx.consultarEstadoJob({ sid: 'SID', instanceUrl: INSTANCIA, jobIds: r.jobIds });
    prueba('un job terminado y otro sin empezar: no dice "JobComplete" mientras no terminen todos', () => {
      assert.strictEqual(est.terminado, false);
      assert.notStrictEqual(est.jobState, 'JobComplete');
    });
  }
  {
    const m = montar({ bulk: { lock: f => /[05]$/.test(f.Contact__c) } });
    const rows = Array.from({ length: 200 }, (_, i) => ['003LCK' + String(i).padStart(9, '0'), 'C', 'D' + i, 'd@t.mx', i % 2 ? '005P400000FpACnIAN' : '005P400000Fp9aHIAR']);
    const r = m.ctx.iniciarImportBulk({ sid: 'SID', instanceUrl: INSTANCIA, object: 'Lead', operation: 'insert', userEmail: USUARIO,
      headers: ['Contact__c', 'Company', 'LastName', 'Email', 'OwnerId'], rows, clientRequestId: 'req_conteo_0001' });
    const auto = m.ctx.recuperarResultadoJob({ sid: 'SID', instanceUrl: INSTANCIA, jobIds: r.jobIds, loteId: r.loteId, reintentarLock: true });
    const manual = m.ctx.recuperarResultadoJob({ sid: 'SID', instanceUrl: INSTANCIA, loteId: r.loteId });
    prueba('al lanzar el reintento por bloqueo, esas filas ya no cuentan como fallidas', () => {
      assert.strictEqual(auto.failed, 0, 'failed=' + auto.failed);
    });
    prueba('al recuperar el lote con su reintento, las filas reintentadas no cuentan doble', () => {
      assert.strictEqual(manual.processed, 200, 'processed=' + manual.processed);
      assert.strictEqual(manual.failed, 0, 'failed=' + manual.failed);
    });
  }

  setGrupo('v18.3 · Exportes, auditoría y entradas');
  {
    const m = montar();
    m.g.agregarCarpeta({ id: 'carpetaAjena_00000000000000', nombre: 'Ajena', owner: 'otra.persona@docplanner.com' });
    m.g.agregarCarpeta({ id: 'carpetaPropia_0000000000000', nombre: 'Mía', owner: USUARIO });
    const exp = folderId => m.post({ idToken: m.token(), action: 'exportSheet', fileName: 'Prueba', folderId,
      summary: {}, preTemplateHeaders: ['A'], preTemplateRows: [['1']], importResultHeaders: ['A'], importResultRows: [['1']] });
    prueba('exportar a una carpeta donde el usuario no es editor → rechazado, sin crear el Sheet', () => {
      const antes = m.g.spreadsheets.size;
      const r = exp('https://drive.google.com/drive/folders/carpetaAjena_00000000000000');
      assert.ok(/permiso de editor/.test(r.error), JSON.stringify(r));
      assert.strictEqual(m.g.spreadsheets.size, antes);
    });
    prueba('…a su carpeta o a la COE sí', () => {
      assert.strictEqual(exp('carpetaPropia_0000000000000').folderMoved, true);
      assert.strictEqual(exp('').folderMoved, true);
    });
  }
  {
    const m = montar();
    const ss = m.g.spreadsheets.get('sheet_prueba');
    ss.insertSheet('Usuarios');
    ss.hojas.unshift(ss.hojas.pop());   // alguien movió "Usuarios" al principio
    m.post({ idToken: 'aaa.' + Buffer.from(JSON.stringify({ email: 'x@docplanner.com', exp: 9e9, aud: m.ctx.GOOGLE_CLIENT_ID, iss: 'accounts.google.com' })).toString('base64url') + '.firmaXXXXXXXXXX', action: 'describe' });
    prueba('la auditoría nunca escribe en la pestaña Usuarios aunque esté primero', () => {
      const usuarios = m.g.hoja(null, 'Usuarios').datos.map(f => String(f[3] || ''));
      assert.ok(!usuarios.some(e => /auth_rechazado|no_autorizado/.test(e)), JSON.stringify(m.g.hoja(null, 'Usuarios').datos.slice(0, 3)));
      assert.ok(m.g.auditoria.some(f => f[3] === 'auth_rechazado'));
    });
  }
  {
    const m = montar();
    prueba('sanitizarPayload nunca deja filas, IDs, reps ni correos en el log', () => {
      const s = JSON.stringify(m.ctx.sanitizarPayload({ rows: [['003A00000000001', 'Pérez']], ids: ['003A00000000001'], reps: [{ email: 'rep@x.mx', cuota: 1 }], email: 'a@b.mx', sid: 'SECRETO' }));
      assert.ok(!/Pérez|003A|rep@x|a@b|SECRETO/.test(s), s);
    });
    prueba('un dato con el tipo equivocado da un error claro (no "trim is not a function")', () => {
      const r = m.post({ idToken: m.token(), action: 'exportSheet', fileName: 123, summary: {} });
      assert.ok(/Dato no válido: fileName/.test(r.error), JSON.stringify(r));
      const r2 = m.post({ idToken: m.token(), action: 'importStart', sid: 'SID', instanceUrl: INSTANCIA, headers: ['A'], rows: [[{ x: 1 }]] });
      assert.ok(/Dato no válido: rows/.test(r2.error), JSON.stringify(r2));
    });
    prueba('admins y whitelist de config.local.gs se comparan en minúsculas', () => {
      m.ctx.ADMIN_EMAILS = ['Admin.Prueba@Docplanner.com'];
      assert.strictEqual(m.ctx.esAdmin('admin.prueba@docplanner.com'), true);
      m.ctx.ALLOWED_EMAILS = ['Mayus.Culas@Docplanner.com'];
      m.ctx.AUDIT_SHEET_ID = '';   // sin Sheet: se usa la lista de respaldo
      m.g.cache.clear();
      assert.ok(m.ctx.obtenerWhitelist().includes('mayus.culas@docplanner.com'));
    });
  }

  setGrupo('v18.3 · IDs de Contactos pegados de Excel');
  const dedup = (() => { let f = null; return t => (f = f || cargarFunciones(html, ['dedupIds'], 'dedupIds'))(t); })();
  prueba('IDs separados por comas, punto y coma o tabs (una fila de Excel) se leen uno por uno', () => {
    const r = dedup('003A00000000001,003A00000000002;003A00000000003\t003A00000000004\n003A00000000001');
    assert.deepStrictEqual(r.ids, ['003A00000000001', '003A00000000002', '003A00000000003', '003A00000000004']);
    assert.strictEqual(r.duplicados.length, 1);
  });
};
