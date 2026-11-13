// Simulador de Cat-alyst en el navegador SIN tocar nada real (lo inyecta tests/sim/serve.js).
// - Toda llamada al backend de Apps Script entra por doPost de backend/Code.gs REAL (token,
//   whitelist, rate limit, auditoría y ruteo): la Asignación y el describe van contra el
//   Salesforce falso (tests/lib/sf-falso.js), el import contra la Bulk API falsa
//   (tests/lib/bulk-falso.js) y Google contra tests/lib/google-falso.js.
// - Cualquier otra petición de red de la app (fetch) se BLOQUEA y queda anotada.
// - El botón "▶ Correr simulación" recorre Asignación → Import (varios jobs, un rechazo de
//   dos renglones, un bloqueo que se reintenta solo, doble clic) → Retry → Recuperar por lote.
(function () {
  const SIM = (window.__SIM = { llamadas: [], bloqueadas: [], dialogos: [] });

  // Sin diálogos bloqueantes (se anotan) y sin esperar los segundos del sondeo
  window.alert = m => SIM.dialogos.push('alert: ' + m);
  window.confirm = m => { SIM.dialogos.push('confirm: ' + m); return true; };
  const st = window.setTimeout;
  window.setTimeout = (f, ms, ...a) => st(f, ms >= 1000 ? 20 : ms, ...a);

  // ── Salesforce, Bulk API y Google falsos ──
  const ERROR_DOS_RENGLONES = 'FIELD_CUSTOM_VALIDATION_EXCEPTION:Este contacto ya tiene un Lead abierto.\nRevisa el Lead existente antes de crear otro.:--';
  const sf = SFFalso.crearSalesforceFalso();
  const bulk = BulkFalso.crearBulkFalso({
    rechazo: f => (f.LastName === 'Doc1' ? ERROR_DOS_RENGLONES
      : f.LastName === 'Doc3' ? 'REQUIRED_FIELD_MISSING:Required fields are missing: [Company, Email]:Company Email --' : ''),
    lock: f => f.LastName === 'Doc5',
    sondeosParaTerminar: 1
  });
  const google = GoogleFalso.crearGoogleFalso();
  SIM.bulk = bulk; SIM.sf = sf; SIM.google = google;
  SIM.auditoria = google.auditoria;
  const googleFetch = GoogleFalso.urlFetchFiel(google.google);
  const destino = url => (/googleapis\.com/.test(url) ? googleFetch : /\/jobs\/ingest/.test(url) ? bulk.UrlFetchApp : sf.UrlFetchApp);
  const UrlFetchApp = {
    fetch: (url, o) => destino(url).fetch(url, o),
    fetchAll(reqs) {
      let error = null;
      const out = reqs.map(r => { try { return destino(r.url).fetch(r.url, r); } catch (e) { error = error || e; return null; } });
      if (error) throw error;
      return out;
    }
  };

  // ── Backend: Code.gs real, con doPost de punta a punta ──
  const realFetch = window.fetch.bind(window);
  let backend = null;
  async function cargarBackend() {
    if (backend) return backend;
    const config = await (await realFetch('/tests/lib/config-prueba.gs')).text();   // v17.1: la config real no está en git
    const code = config + '\n' + (await (await realFetch('/backend/Code.gs')).text()).replace(/^﻿/, '');
    const nombres = ['UrlFetchApp', ...Object.keys(google.globales)];
    backend = new Function(...nombres, code + '\n;return { doPost, doGet, normalizarAccion, GOOGLE_CLIENT_ID, VERSION_BACKEND };')
      (UrlFetchApp, ...Object.keys(google.globales).map(k => google.globales[k]));
    return backend;
  }

  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith(location.origin) || !/^https?:/i.test(u)) return realFetch(url, opts);   // archivos del propio simulador
    if (!u.includes('script.google.com')) { SIM.bloqueadas.push(u); throw new Error('Bloqueado por la simulación: ' + u); }
    const b = await cargarBackend();
    let accion = '(sin cuerpo)';
    try { accion = b.normalizarAccion(JSON.parse(opts.body).action); } catch (e) {}
    SIM.llamadas.push(accion);
    const salida = b.doPost({ postData: { contents: String(opts && opts.body || '') } });
    // Una vuelta al event loop, como una petición real
    await new Promise(r => st(r, 5));
    return new Response(salida.getContent(), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  // Login falso local: no habla con Google. El token queda registrado en el tokeninfo falso,
  // así que doPost lo valida igual que en producción (aud, dominio, exp y whitelist).
  SIM.EMAIL = 'simulacion@docplanner.com';
  async function login() {
    const b = await cargarBackend();
    const b64 = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = b64('{"alg":"RS256"}') + '.' + b64(JSON.stringify({ email: SIM.EMAIL, given_name: 'Simón', exp, hd: 'docplanner.com', aud: b.GOOGLE_CLIENT_ID, iss: 'https://accounts.google.com' })) + '.firmaSimulada';
    google.registrarToken(token, { aud: b.GOOGLE_CLIENT_ID, hd: 'docplanner.com', email_verified: 'true', exp: String(exp), email: SIM.EMAIL });
    onSignIn({ credential: token });
  }

  // ── Escenario completo ──
  SIM.correr = async function () {
    const checks = [];
    const check = (nombre, ok, detalle) => checks.push({ nombre, ok: !!ok, detalle: detalle || '' });
    SIM.llamadas.length = 0; SIM.bloqueadas.length = 0;

    if (document.getElementById('mainApp').style.display !== 'flex') await login();
    const bienvenida = document.getElementById('toast').textContent;
    check('El nombre con acento del login se lee bien (JWT en UTF-8)', /Simón/.test(bienvenida), bienvenida);
    document.getElementById('sid').value = 'SID-FALSO';
    document.getElementById('businessLine').value = 'Agenda Premium';
    document.getElementById('repsBody').innerHTML = '';
    Object.keys(SFFalso.USUARIOS).forEach(email => addRep(email, 50));
    addRep('sin.numero@test.local', '');   // v18.3: un rep sin número se avisa
    const area = document.getElementById('idsArea');
    area.value = SFFalso.idsDeReporte();
    area.dispatchEvent(new Event('input'));

    // 1. Asignación
    const contador = document.getElementById('idsCount').textContent;
    check('El contador avisa los duplicados descartados', /duplicad/.test(contador), contador);
    await ejecutar();
    const log = document.getElementById('logBox').innerText;
    check('El log de ejecución avisa los duplicados', /duplicados descartados/.test(log));
    check('Un rep con email pero sin número se avisa en el log', /sin número/.test(log));
    const iC = PT_HEADERS.indexOf('Contact__c');
    const cuenta = {};
    preTemplateRows.forEach(r => { const k = String(r[iC]).slice(0, 15); cuenta[k] = (cuenta[k] || 0) + 1; });
    const repetidos = Object.keys(cuenta).filter(k => cuenta[k] > 1);
    check('Ningún Contact__c repetido en el pre-template', !repetidos.length, repetidos.length ? repetidos.map(SFFalso.to18).join(', ') : preTemplateRows.length + ' filas');

    // 2. Import con doble clic
    irAImport();
    const filasPT = preTemplateRows.length;
    await Promise.all([ejecutarImport(), ejecutarImport()]);
    await new Promise(r => st(r, 50));
    const idsLock = SIM.auditoria.filter(f => f[2] === 'reintentoLock').map(f => String(f[4]));
    const principales = bulk.jobs.filter(j => !idsLock.some(d => d.includes('jobId=' + j.id)));
    check('El import se partió en varios jobs que corrieron a la vez', principales.length >= 2, principales.map(j => j.id).join(', '));
    check('Doble clic: un solo import (sin Leads duplicados en Salesforce)',
      new Set(bulk.creados.map(c => c.fila.Contact__c)).size === bulk.creados.length && bulk.creados.length === filasPT - 2,
      bulk.creados.length + ' Leads creados para ' + filasPT + ' filas (2 rechazadas)');
    const fallidas = importResultRows.filter(r => r.__Status === 'Failed');
    check('El resultado tiene una fila por cada fila importada', importResultRows.length === filasPT,
      importResultRows.length + ' filas de resultado para ' + filasPT + ' importadas');
    check('Las filas con error conservan sus columnas', fallidas.length === 2 && fallidas.every(r => r.Contact__c && r.LastName && r.OwnerId),
      fallidas.map(r => (r.Contact__c || '∅') + ' / ' + (r.LastName || '∅')).join(' · '));
    check('El error de dos renglones llega completo a __Errors', fallidas.some(r => r.__Errors === ERROR_DOS_RENGLONES.replace('\n', ' ')));
    const bloqueada = importResultRows.find(r => r.LastName === 'Doc5');
    check('La fila con UNABLE_TO_LOCK_ROW se reintentó sola y quedó OK', bloqueada && bloqueada.__Status === 'Succeeded' && /bloqueo/.test(bloqueada.__Action),
      bloqueada ? bloqueada.__Status + ' · ' + bloqueada.__Action : 'no está');
    const logImport = document.getElementById('importLog').innerText;
    check('El log muestra el tiempo total y los tiempos de Salesforce', /Tiempo total/.test(logImport) && /Apex/.test(logImport));

    // 3. Retry de las 2 fallidas (siguen fallando: son rechazos de validación)
    const creadosAntes = bulk.creados.length;
    abrirModalRetry();
    await ejecutarRetry();
    check('El retry no duplica ni pierde filas', importResultRows.length === filasPT && bulk.creados.length === creadosAntes &&
      importResultRows.filter(r => r.__Status === 'Failed').length === 2, historialRetries.length + ' intentos en el historial');

    // 4. Recuperar por lote
    const lote = (historialRetries[0] || {}).jobId || '';
    abrirModalRecuperar();
    document.getElementById('recuperarJobId').value = lote;
    await ejecutarRecuperar();
    check('Recuperar por Lote trae el import completo', /^lote_/.test(lote) && importResultRows.length === filasPT,
      lote + ' → ' + importResultRows.length + ' filas');
    const doc5 = importResultRows.find(r => r.LastName === 'Doc5');
    check('Al recuperar, la fila que se reintentó por bloqueo sale OK (un Retry no la duplicaría)',
      doc5 && doc5.__Status === 'Succeeded' && importResultRows.filter(r => r.__Status === 'Failed').length === 2,
      doc5 ? doc5.__Status + ' · fallidas: ' + importResultRows.filter(r => r.__Status === 'Failed').length : 'no está');

    // 4b. v18: el SID vence mientras Salesforce procesa → el lote queda pendiente. Un segundo
    // clic en Importar no debe crear otro import, y al recuperar el lote la tabla se completa.
    const iCp = PT_HEADERS.indexOf('Contact__c');
    preTemplateRows = preTemplateRows.slice(0, 12).map((r, i) => { const n = [...r]; n[iCp] = '003SIMPEND' + String(i).padStart(5, '0'); return n; });
    renderPreTemplate(PT_HEADERS, preTemplateRows);
    bulk.opciones.excepcion = p => { if (p.paso === 'estado') { bulk.opciones.sesionVencida = true; bulk.opciones.excepcion = null; } return ''; };
    await ejecutarImport();
    const enProceso = importResultRows.filter(r => r.__Status === 'En proceso').length;
    check('SID vencido a media espera: las filas quedan "En proceso" y el Retry no las toma',
      enProceso === 12 && document.getElementById('retryBtn').disabled, enProceso + ' en proceso de ' + importResultRows.length);
    bulk.opciones.sesionVencida = false;
    const jobsAntes = bulk.jobs.length;
    SIM.dialogos.length = 0;
    await ejecutarImport();
    check('Un segundo clic en Importar con el lote pendiente se bloquea (no crea jobs)',
      bulk.jobs.length === jobsAntes && SIM.dialogos.some(d => /bloqueado/.test(d)), (bulk.jobs.length - jobsAntes) + ' jobs nuevos');
    await ejecutarRecuperar();   // el aviso de bloqueo abrió Recuperar con el lote
    const sinResultado = importResultRows.filter(r => r.__Status === 'En proceso').length;
    check('Al recuperar el lote, sus filas toman su resultado y ya no queda pendiente',
      sinResultado === 0 && importResultRows.length === 12 && typeof leerPendientes === 'function' && !leerPendientes().length,
      sinResultado + ' en proceso · ' + (typeof leerPendientes === 'function' ? leerPendientes().length : '?') + ' pendientes');
    check('Sin Leads duplicados en todo el recorrido', new Set(bulk.creados.map(c => c.fila.Contact__c)).size === bulk.creados.length,
      bulk.creados.length + ' Leads');

    // 4c. v18 · Datos al campo correcto: campos custom, mapeo, valores manuales, picklists y país
    await camposCorrectos(check);

    // 5. Todo pasó por doPost real: auditoría, y un token que Google no conoce se rechaza
    check('La auditoría registró el import y su lote (doPost real)',
      SIM.auditoria.some(f => f[2] === 'import' && f[3] === 'iniciado' && /lote=lote_/.test(f[4])), SIM.auditoria.length + ' filas de auditoría');
    const ajeno = await (await fetch(APPS_SCRIPT_URL, { method: 'POST', body: JSON.stringify({ idToken: 'aaa.bbb.ccc', action: 'describe' }) })).json();
    check('Un token que Google no reconoce se rechaza en el backend', ajeno.authError === true, JSON.stringify(ajeno));

    // 6. v18 · Sesión y robustez
    await sesionYRobustez(check);

    check('Ninguna llamada salió a sistemas reales', !SIM.bloqueadas.length, SIM.bloqueadas.join(', ') || 'backend simulado: ' + [...new Set(SIM.llamadas)].join(' → '));

    mostrarPanel(checks);
    return checks;
  };

  async function exportes(check) {
    const abiertas = [];
    const abrirReal = window.open;
    window.open = url => {
      const v = { closed: false, document: { write() {} }, location: { href: url || '' }, close() { this.closed = true; } };
      abiertas.push(v);
      return v;
    };
    abrirModalExport();
    setMode('new');
    document.getElementById('exportFileName').value = 'COE-PRUEBA';
    const antes = SIM.google.spreadsheets.size;
    await Promise.all([ejecutarExport(), ejecutarExport()]);   // doble clic
    await ejecutarExport();                                     // y otro clic después de terminar
    const creados = SIM.google.spreadsheets.size - antes;
    window.open = abrirReal;
    cerrarModalExport();
    check('Guardar en Sheets: doble clic y un clic después de terminar crean UN solo Sheet', creados === 1, creados + ' Sheet(s)');
    check('La pestaña del Sheet se abre con el clic (sin bloqueo de popups) y recibe el link',
      abiertas.length === 1 && /docs\.google\.com\/spreadsheets/.test(abiertas[0].location.href), abiertas.map(v => v.location.href || '(vacía)').join(' · '));
  }

  async function sesionYRobustez(check) {
    const espera = ms => new Promise(r => st(r, ms));
    const modalAbierto = () => !!document.getElementById('reloginModal') && document.getElementById('reloginModal').classList.contains('open');
    const describeLead = () => backendFetch({ action: 'describe', sid: 'SID-FALSO', instanceUrl: INSTANCE_URL, object: 'Lead' });
    const filas = JSON.stringify(preTemplateRows);

    // a) el token venció: la petición espera a que la persona vuelva a entrar y luego sigue
    tokenExpMs = Date.now() - 1000;
    let resultado = null;
    const pendiente = describeLead().then(d => { resultado = d; }, e => { resultado = e; });
    await espera(30);
    const seAbrio = modalAbierto();
    const b64 = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    onSignIn({ credential: b64('{"alg":"RS256"}') + '.' + b64(JSON.stringify({ email: 'otra.persona@docplanner.com', exp: Math.floor(Date.now() / 1000) + 3600 })) + '.x' });
    const otraCuentaRechazada = modalAbierto() && resultado === null;
    await login();
    await pendiente;
    check('Token de Google vencido: se pide entrar otra vez y la petición sigue (sin perder filas)',
      seAbrio && !modalAbierto() && resultado && Array.isArray(resultado.fields) && JSON.stringify(preTemplateRows) === filas,
      'recuadro: ' + seAbrio + ' · resultado: ' + (resultado && (resultado.fields ? resultado.fields.length + ' campos' : resultado.message)));
    check('Volver a entrar con otra cuenta no se acepta', otraCuentaRechazada);

    // b) el backend rechaza el token y hay filas: no se cierra la sesión, se pide entrar otra vez
    SIM.google.tokens.clear();
    [...SIM.google.cache.keys()].filter(k => k.startsWith('tok_')).forEach(k => SIM.google.cache.delete(k));
    let error = null;
    try { await describeLead(); } catch (e) { error = e; }
    await espera(60);
    check('Si el backend rechaza el token con filas en pantalla, no se cierra la sesión',
      error && error.authError && document.getElementById('mainApp').style.display === 'flex' && modalAbierto() && JSON.stringify(preTemplateRows) === filas,
      error ? error.message : 'sin error');
    await login();

    // c) respuesta que no es JSON → mensaje claro
    const fetchReal = window.fetch;
    window.fetch = async () => new Response('<html><body>Service unavailable</body></html>', { status: 200 });
    let msg = '';
    try { await describeLead(); } catch (e) { msg = e.message; }
    window.fetch = fetchReal;
    check('Si Apps Script responde algo que no es JSON, el mensaje lo dice claro', /no es JSON/.test(msg), msg.slice(0, 120));

    // d) aviso al cerrar la pestaña con resultados sin guardar; al guardarlos ya no
    const intentarCerrar = () => { const ev = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(ev); return ev.defaultPrevented; };
    const avisaSinGuardar = importResultRows.length > 0 && intentarCerrar();
    setMode('csv');
    document.getElementById('csvFileName').value = 'prueba_sim';
    await ejecutarExport();
    check('Cerrar la pestaña con resultados sin guardar avisa; después de guardarlos, no', avisaSinGuardar && !intentarCerrar(),
      'antes: ' + avisaSinGuardar + ' · después: ' + intentarCerrar());
    check('El log dice cuántos jobs y de cuántas filas', /job\(s\) de ~\d+ filas/.test(document.getElementById('importLog').innerText));

    // v18.3 · Guardar en Sheets: un solo Sheet y la pestaña se abre con el clic
    await exportes(check);

    // e) Salir limpia todo (IDs, reps, filas) aunque se vuelva a entrar con otra persona
    document.getElementById('idsArea').value = '003TEST00000001';
    logout();
    const limpio = !preTemplateRows.length && !importResultRows.length && !document.getElementById('idsArea').value &&
      document.querySelectorAll('#repsBody tr').length === 1 && !idTokenCache;
    check('Salir limpia filas, resultados, IDs, reps y el token', limpio);
    await login();
  }

  async function camposCorrectos(check) {
    const espera = ms => new Promise(r => st(r, ms));
    const alineadas = () => preTemplateRows.every(r => r.length === PT_HEADERS.length);
    const col = n => PT_HEADERS.indexOf(n);
    // Filas nuevas (otros contactos) para no tocar lo de arriba
    preTemplateRows = preTemplateRows.slice(0, 8).map((r, i) => { const n = [...r]; n[col('Contact__c')] = '003SIMCAMP' + String(i).padStart(5, '0'); return n; });
    renderPreTemplate(PT_HEADERS, preTemplateRows);
    const apellidos = preTemplateRows.map(r => r[col('LastName')]);

    // a) un campo custom Manual entra a las filas con su valor; uno desde SF entra vacío
    setCustomMode('manual');
    document.getElementById('newCustomFieldInput').value = 'Campaign_Code__c';
    document.getElementById('customManualValue').value = 'CAMP1';
    await agregarCustomField();
    setCustomMode('sf');
    document.getElementById('newCustomFieldInput').value = 'Phone';
    await agregarCustomField();
    check('Campos custom nuevos entran a las filas que ya existen (Manual con su valor)',
      alineadas() && preTemplateRows.every(r => r[col('Campaign_Code__c')] === 'CAMP1' && r[col('Phone')] === ''),
      PT_HEADERS.slice(-2).join(', ') + ' · ' + preTemplateRows[0].length + ' de ' + PT_HEADERS.length + ' columnas');

    // b) quitar un custom quita su columna de las filas: lo demás no se corre
    quitarCustomField(customFields.findIndex(c => c.name === 'Campaign_Code__c'));
    check('Quitar un campo custom quita su columna de las filas (los valores no se corren)',
      alineadas() && preTemplateRows.every((r, i) => r[col('LastName')] === apellidos[i]) && col('Campaign_Code__c') === -1,
      preTemplateRows[0].length + ' columnas en la fila · ' + PT_HEADERS.length + ' en el encabezado');

    // c) al entrar a Import el mapeo se rehace con las columnas actuales
    switchTab('import');
    check('Al entrar a Import el Field Mapping cuadra con las columnas actuales',
      typeof leerMapeo === 'function' && leerMapeo().map(m => m.col).join('|') === PT_HEADERS.join('|'));

    // d) un valor manual de un campo fijo se aplica a las filas que ya existen
    await onFieldSourceChange({ value: 'manual' }, 'Status');
    onFixedManualValueInput('Status', 'Qualifying');
    await espera(500);
    check('Un valor manual nuevo (Status) se aplica a las filas que ya existen', preTemplateRows.every(r => r[col('Status')] === 'Qualifying'));

    // e) un país fuera del picklist se bloquea antes de mandar; con PE (Peru) sí pasa
    const jobsAntes = bulk.jobs.length;
    preTemplateRows[2] = [...preTemplateRows[2]]; preTemplateRows[2][col('Country__c')] = 'Peruu';
    SIM.dialogos.length = 0;
    await ejecutarImport();
    check('Un valor fuera del picklist (Country__c = "Peruu") bloquea el import antes de mandarlo',
      bulk.jobs.length === jobsAntes && SIM.dialogos.some(d => /no está en la lista/.test(d)), (bulk.jobs.length - jobsAntes) + ' jobs nuevos · ' + SIM.dialogos.join(' | ').slice(0, 300) + ' · log: ' + document.getElementById('importLog').innerText.slice(-300));

    // f) durante un import no se puede cambiar país ni campos
    importEnCurso = true;
    const antes = JSON.stringify(preTemplateRows);
    seleccionarPais('CO');
    quitarCustomField(0);
    importEnCurso = false;
    check('Con un import en curso no se cambian país ni campos', JSON.stringify(preTemplateRows) === antes && paisActivo !== 'CO');

    seleccionarPais('PE');   // el confirm del simulador dice que sí: toda la columna a "Peru"
    await ejecutarImport();
    const nuevos = bulk.creados.filter(c => /^003SIMCAMP/.test(c.fila.Contact__c));
    const porContacto = Object.fromEntries(preTemplateRows.map(r => [r[col('Contact__c')], r]));
    const bien = nuevos.length > 0 && nuevos.every(c => {
      const r = porContacto[c.fila.Contact__c];
      return r && c.fila.LastName === r[col('LastName')] && c.fila.Country__c === 'Peru' && c.fila.Status === 'Qualifying' && 'Phone' in c.fila;
    });
    check('Cada Lead llega con sus valores en su campo (LastName, Country__c = Peru, Status, Phone)', bien,
      nuevos.length + ' Leads · ' + (nuevos[0] ? JSON.stringify(nuevos[0].fila).slice(0, 160) : ''));

    // g) Recuperar no borra la tabla sin preguntar
    const filasTabla = importResultRows.length;
    const confirmar = window.confirm;
    window.confirm = m => { SIM.dialogos.push('confirm: ' + m); return false; };
    abrirModalRecuperar();
    document.getElementById('recuperarJobId').value = (historialRetries[0] || {}).jobId || '';
    const refAntes = (historialRetries[0] || {}).jobId;
    await ejecutarRecuperar();
    window.confirm = confirmar;
    cerrarModalRecuperar();
    check('Recuperar pregunta antes de reemplazar la tabla (y si dices que no, la deja igual)',
      importResultRows.length === filasTabla && (historialRetries[0] || {}).jobId === refAntes && SIM.dialogos.some(d => /Reemplazarlo/.test(d)),
      filasTabla + ' filas');

    // Se deja la configuración como estaba para lo que sigue
    customFields = []; fieldsManualValues = {}; camposFijosOcultos = []; fieldsFromSF = [];
    actualizarHeadersDinamicos();
  }

  function mostrarPanel(checks) {
    let p = document.getElementById('simPanel');
    if (!p) { p = document.createElement('div'); p.id = 'simPanel'; document.body.appendChild(p); }
    const fallas = checks.filter(c => !c.ok).length;
    p.style.cssText = 'position:fixed;right:16px;bottom:64px;z-index:9999;max-width:460px;max-height:70vh;overflow:auto;background:#11131c;color:#e6e8ef;border:1px solid ' +
      (fallas ? '#e5484d' : '#30a46c') + ';border-radius:10px;padding:12px 14px;font:12px/1.5 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4)';
    p.innerHTML = '<b>' + (fallas ? '✗ ' + fallas + ' de ' + checks.length + ' fallaron' : '✓ ' + checks.length + ' de ' + checks.length + ' pasaron') + '</b>' +
      checks.map(c => '<div style="margin-top:6px">' + (c.ok ? '✓ ' : '✗ ') + esc(c.nombre) +
        (c.detalle ? '<div style="opacity:.65;margin-left:16px">' + esc(c.detalle) + '</div>' : '') + '</div>').join('');
  }

  window.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('button');
    b.textContent = '▶ Correr simulación';
    b.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;padding:9px 14px;border-radius:8px;border:0;background:#6e56cf;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer';
    b.onclick = async () => { b.disabled = true; b.textContent = '⏳ Simulando…'; try { await SIM.correr(); } finally { b.disabled = false; b.textContent = '▶ Correr simulación'; } };
    document.body.appendChild(b);
  });
})();
