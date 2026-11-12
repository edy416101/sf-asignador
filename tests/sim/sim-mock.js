// Simulador de Cat-alyst en el navegador SIN tocar nada real (lo inyecta tests/sim/serve.js).
// - Toda llamada al backend de Apps Script se responde aquí: la Asignación corre backend/Code.gs REAL
//   contra el Salesforce falso (tests/lib/sf-falso.js); el import usa un Bulk API falso.
// - Cualquier otra petición de red de la app se BLOQUEA y queda anotada.
// - El botón "▶ Correr simulación" hace Asignación + Data Import y muestra qué pasó y qué falló.
(function () {
  const SIM = (window.__SIM = { llamadas: [], bloqueadas: [], dialogos: [] });

  // Sin diálogos bloqueantes (se anotan) y sin esperar 10 s entre sondeos del import
  window.alert = m => SIM.dialogos.push('alert: ' + m);
  window.confirm = m => { SIM.dialogos.push('confirm: ' + m); return true; };
  const st = window.setTimeout;
  window.setTimeout = (f, ms, ...a) => st(f, ms === 10000 ? 30 : ms, ...a);

  // ── Backend: Code.gs real para la Asignación ──
  const realFetch = window.fetch.bind(window);
  const sf = SFFalso.crearSalesforceFalso();
  let procesarAsignacion = null;
  async function cargarBackend() {
    if (procesarAsignacion) return;
    const code = (await (await realFetch('/backend/Code.gs')).text()).replace(/^﻿/, '');
    procesarAsignacion = new Function('UrlFetchApp', 'Logger', code + '\n;return procesarAsignacion;')(sf.UrlFetchApp, { log() {} });
  }

  // ── Bulk API falsa: falla la fila 2 (error de dos renglones) y la 4 (error de un renglón) ──
  const ERROR_DOS_RENGLONES = 'FIELD_CUSTOM_VALIDATION_EXCEPTION:Este contacto ya tiene un Lead abierto.\nRevisa el Lead existente antes de crear otro.:--';
  const FALLAS = { 1: ERROR_DOS_RENGLONES, 3: 'REQUIRED_FIELD_MISSING:Required fields are missing: [Company, Email]:Company Email --' };
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  let ultimoImport = { headers: [], rows: [] };
  function resultadoImport() {
    const h = ultimoImport.headers;
    const ok = [['sf__Id', 'sf__Created', ...h].map(q).join(',')];
    const fail = [['sf__Id', 'sf__Error', ...h].map(q).join(',')];
    ultimoImport.rows.forEach((r, i) => {
      if (FALLAS[i]) fail.push(['', FALLAS[i], ...r].map(q).join(','));
      else ok.push(['00QSIM' + String(i).padStart(9, '0'), 'true', ...r].map(q).join(','));
    });
    return { jobId: '750SIM000000001', jobState: 'JobComplete', successCsv: ok.join('\n') + '\n', failedCsv: fail.join('\n') + '\n',
             processed: ultimoImport.rows.length, failed: Object.keys(FALLAS).length, errorMessage: '' };
  }
  const CAMPOS_LEAD = ['Contact__c', 'LastSourceAt__c', 'Company', 'LastName', 'Email', 'OwnerId', 'BusinessLine__c', 'Lead_Type__c',
    'ContactTypeSegment__c', 'Country__c', 'Leadassist__Use_Round_Robin__c', 'Status', 'FacilitySize__c'];

  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith(location.origin) || !/^https?:/i.test(u)) return realFetch(url, opts);   // archivos del propio simulador
    if (!u.includes('script.google.com')) { SIM.bloqueadas.push(u); throw new Error('Bloqueado por la simulación: ' + u); }
    const p = JSON.parse(opts.body);
    const action = p.action || 'asignacion';
    SIM.llamadas.push(action);
    let data;
    if (action === 'asignacion') { await cargarBackend(); data = procesarAsignacion(p); }
    else if (action === 'describe') data = { fields: CAMPOS_LEAD, fieldsMetadata: {} };
    else if (action === 'importStart') { ultimoImport = { headers: p.headers, rows: p.rows }; data = { jobId: '750SIM000000001' }; }
    else if (action === 'jobStatus') data = { terminado: true, jobState: 'JobComplete', processed: ultimoImport.rows.length, failed: Object.keys(FALLAS).length };
    else if (action === 'recuperarJob') data = resultadoImport();
    else data = {};
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  // Login falso local: no habla con Google, solo muestra la app
  function login() {
    const b64 = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    onSignIn({ credential: b64('{"alg":"none"}') + '.' + b64(JSON.stringify({ email: 'simulacion@docplanner.com', given_name: 'Sim' })) + '.sim' });
  }

  // ── Escenario completo: Asignación con IDs repetidos + Data Import con 2 filas fallidas ──
  SIM.correr = async function () {
    const checks = [];
    const check = (nombre, ok, detalle) => checks.push({ nombre, ok: !!ok, detalle: detalle || '' });
    SIM.llamadas.length = 0; SIM.bloqueadas.length = 0;

    if (document.getElementById('mainApp').style.display !== 'flex') login();
    document.getElementById('sid').value = 'SID-FALSO';
    document.getElementById('businessLine').value = 'Agenda Premium';
    document.getElementById('repsBody').innerHTML = '';
    Object.keys(SFFalso.USUARIOS).forEach(email => addRep(email, 50));
    const area = document.getElementById('idsArea');
    area.value = SFFalso.idsDeReporte();
    area.dispatchEvent(new Event('input'));

    const contador = document.getElementById('idsCount').textContent;
    check('El contador avisa los duplicados descartados', /duplicad/.test(contador), contador);
    await ejecutar();
    const log = document.getElementById('logBox').innerText;
    check('El log de ejecución avisa los duplicados', /duplicados descartados/.test(log));
    const iC = PT_HEADERS.indexOf('Contact__c');
    const cuenta = {};
    preTemplateRows.forEach(r => { const k = String(r[iC]).slice(0, 15); cuenta[k] = (cuenta[k] || 0) + 1; });
    const repetidos = Object.keys(cuenta).filter(k => cuenta[k] > 1);
    check('Ningún Contact__c repetido en el pre-template', !repetidos.length, repetidos.length ? repetidos.map(SFFalso.to18).join(', ') : preTemplateRows.length + ' filas');

    irAImport();
    await ejecutarImport();
    await new Promise(r => st(r, 300));
    const fallidas = importResultRows.filter(r => r.__Status === 'Failed');
    check('El resultado del import tiene una fila por cada fila importada', importResultRows.length === preTemplateRows.length,
      importResultRows.length + ' filas de resultado para ' + preTemplateRows.length + ' importadas');
    check('Las filas con error conservan sus columnas', fallidas.length === 2 && fallidas.every(r => r.Contact__c && r.LastName && r.OwnerId),
      fallidas.map(r => (r.Contact__c || '∅') + ' / ' + (r.LastName || '∅')).join(' · '));
    check('El error de dos renglones llega completo a __Errors', fallidas.some(r => r.__Errors === ERROR_DOS_RENGLONES.replace('\n', ' ')));
    check('Ninguna llamada salió a sistemas reales', !SIM.bloqueadas.length, SIM.bloqueadas.join(', ') || 'backend simulado: ' + SIM.llamadas.join(' → '));

    mostrarPanel(checks);
    return checks;
  };

  function mostrarPanel(checks) {
    let p = document.getElementById('simPanel');
    if (!p) { p = document.createElement('div'); p.id = 'simPanel'; document.body.appendChild(p); }
    const fallas = checks.filter(c => !c.ok).length;
    p.style.cssText = 'position:fixed;right:16px;bottom:64px;z-index:9999;max-width:460px;background:#11131c;color:#e6e8ef;border:1px solid ' +
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
