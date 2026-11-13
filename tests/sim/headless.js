// Corre el simulador del navegador sin intervención: Chrome headless por CDP, presiona
// "Correr simulación" y reporta los checks. Código de salida 1 si algo falla.
//
// Candado de red: Chrome solo puede pedir archivos a localhost y a las librerías públicas de
// abajo. Cualquier otra petición (Salesforce, Apps Script, Google, Drive…) se corta en el
// navegador y la corrida FALLA, aunque el código la haya intentado por un camino que el
// simulador no cubría (script, imagen, XHR, beacon).
//
// Uso:  node tests/sim/headless.js                  → index.html del repo
//       node tests/sim/headless.js ruta/index.html  → otra versión
// Variable CHROME_PATH si Chrome no está en la ruta de siempre.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const RAIZ = path.resolve(__dirname, '..', '..');
const PERMITIDOS = ['localhost', '127.0.0.1', 'cdn.sheetjs.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const RUTAS_CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium'
].filter(Boolean);
const dormir = ms => new Promise(r => setTimeout(r, ms));
const puerto = () => 20000 + Math.floor(Math.random() * 30000);

function permitido(url) {
  if (/^(data|blob|about|chrome|devtools):/i.test(url)) return true;
  try { return PERMITIDOS.includes(new URL(url).hostname); } catch (e) { return false; }
}

async function correr(indexHtml) {
  const chromeExe = RUTAS_CHROME.find(p => fs.existsSync(p));
  if (!chromeExe) return { ok: false, salida: '✗ No encontré Chrome ni Edge. Pon su ruta en CHROME_PATH.' };

  const pWeb = puerto(), pCdp = pWeb + 1;
  const args = [path.join(RAIZ, 'tests/sim/serve.js')];
  if (indexHtml) args.push(indexHtml);
  const server = spawn(process.execPath, args, { env: { ...process.env, PORT: String(pWeb) } });
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-sim-'));
  const chrome = spawn(chromeExe, ['--headless=new', '--remote-debugging-port=' + pCdp, '--user-data-dir=' + perfil,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', 'about:blank']);
  const lineas = [];
  const out = s => lineas.push(s);
  const cerrar = () => {
    try { chrome.kill(); } catch (e) {}
    try { server.kill(); } catch (e) {}
    setTimeout(() => { try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (e) {} }, 1500);
  };

  try {
    let lista = null;
    for (let i = 0; i < 150 && !lista; i++) {
      await dormir(200);
      try { lista = await (await fetch('http://127.0.0.1:' + pCdp + '/json/list')).json(); } catch (e) {}
    }
    const pagina = lista && lista.find(t => t.type === 'page');
    if (!pagina) throw new Error('Chrome no abrió la página de depuración a tiempo.');
    const ws = new WebSocket(pagina.webSocketDebuggerUrl);
    await new Promise((r, x) => { ws.addEventListener('open', r); ws.addEventListener('error', x); });

    let id = 0;
    const pendientes = new Map(), errores = [], bloqueadas = [];
    const cdp = (method, params = {}) => new Promise(r => { const i = ++id; pendientes.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pendientes.has(m.id)) { pendientes.get(m.id)(m); pendientes.delete(m.id); }
      if (m.method === 'Fetch.requestPaused') {
        const { requestId, request } = m.params;
        if (permitido(request.url)) cdp('Fetch.continueRequest', { requestId });
        else { bloqueadas.push(request.url); cdp('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); }
      }
      if (m.method === 'Runtime.exceptionThrown') errores.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errores.push(m.params.args.map(a => a.value || a.description).join(' '));
    });
    await cdp('Fetch.enable', { patterns: [{ urlPattern: '*' }] });   // candado de red, antes de navegar
    await cdp('Runtime.enable');
    await cdp('Page.enable');
    await cdp('Page.navigate', { url: 'http://localhost:' + pWeb + '/' });

    let lista2 = false;
    for (let i = 0; i < 150 && !lista2; i++) {
      await dormir(200);
      const r = await cdp('Runtime.evaluate', { expression: 'document.readyState === "complete" && !!window.__SIM && typeof XLSX !== "undefined"', returnByValue: true });
      lista2 = !!(r.result && r.result.result && r.result.result.value);
    }
    if (!lista2) throw new Error('La página del simulador no terminó de cargar (¿sin internet para SheetJS?).');

    const r = await cdp('Runtime.evaluate', {
      expression: '__SIM.correr().then(c => JSON.stringify({ c, bloqueadasSim: __SIM.bloqueadas, log: document.getElementById("importLog").innerText }))',
      awaitPromise: true, returnByValue: true, timeout: 180000 });
    if (r.result.exceptionDetails) throw new Error('El simulador tronó: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    const { c, bloqueadasSim, log } = JSON.parse(r.result.result.value);

    // Prueba del candado: una imagen a un host .invalid (nunca existe en internet) debe cortarse.
    const SONDA = 'https://candado.catalyst.invalid/sonda.png';
    await cdp('Runtime.evaluate', { expression: `new Promise(r => { const i = new Image(); i.onload = i.onerror = r; i.src = '${SONDA}'; })`, awaitPromise: true });
    c.push({ ok: bloqueadas.includes(SONDA), nombre: 'Candado de red activo (una petición de prueba a internet se cortó)' });

    // El candado también es un check: ninguna petición a sistemas reales.
    const todas = [...new Set([...bloqueadas, ...(bloqueadasSim || [])])].filter(u => u !== SONDA);
    c.push({ ok: todas.length === 0, nombre: 'Candado de red: ninguna petición salió a sistemas reales',
      detalle: todas.length ? 'bloqueadas: ' + todas.join(' · ') : '' });

    c.forEach(x => out((x.ok ? '  ✓ ' : '  ✗ ') + x.nombre + (x.detalle ? '\n      ' + x.detalle : '')));
    if (errores.length) out('\nErrores de consola:\n  ' + errores.join('\n  '));
    const fallas = c.filter(x => !x.ok).length;
    if (fallas) out('\n--- log del import (final) ---\n' + log.split('\n').slice(-25).join('\n'));
    out('\n' + (c.length - fallas) + ' de ' + c.length + ' checks del simulador pasaron');
    return { ok: fallas === 0, salida: lineas.join('\n') };
  } catch (e) {
    out('✗ ' + e.message);
    return { ok: false, salida: lineas.join('\n') };
  } finally {
    cerrar();
  }
}

module.exports = { correr, permitido };

if (require.main === module) {
  correr(process.argv[2]).then(r => { console.log(r.salida); process.exit(r.ok ? 0 : 1); });
}
