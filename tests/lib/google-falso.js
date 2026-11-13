// Servicios de Google FALSOS en memoria para correr backend/Code.gs sin Apps Script y sin red.
// Lo usan las pruebas de Node (tests/lib/cargar.js) y el simulador del navegador (sim-mock.js).
// Se portan como los reales en lo que importa para no perder datos:
//
//   CacheService  · TTL con reloj propio (g.avanzar(ms)), 6 h como máximo, valores de hasta
//                   100 KB y llaves de hasta 250 caracteres (si no, truena como el real).
//   LockService   · tryLock da false y waitLock truena si opciones.lockOcupado (bool o función).
//   SpreadsheetApp/DriveApp · varios Sheets con varias hojas por nombre, create, insertSheet,
//                   carpetas, dueños y editores. El Sheet de auditoría es AUDIT_SHEET_ID.
//   ContentService, Utilities, ScriptApp.
//   urlFetchFiel  · envuelve un UrlFetchApp falso para que truene como el real: URLs de más de
//                   2048 caracteres y respuestas 4xx/5xx sin muteHttpExceptions.
//   google(url)   · tokeninfo y la copia de Drive (XLSX → Sheet) falsos.
(function (raiz) {
  const nodeCrypto = (typeof require === 'function') ? (() => { try { return require('crypto'); } catch (e) { return null; } })() : null;
  const tieneBuffer = typeof Buffer !== 'undefined';

  // ── bytes y base64 (Apps Script usa bytes con signo) ──
  const conSigno = arr => Array.from(arr, b => (b > 127 ? b - 256 : b));
  const sinSigno = arr => Uint8Array.from(arr, b => b & 255);
  const utf8 = s => (tieneBuffer ? conSigno(Buffer.from(String(s), 'utf8')) : conSigno(new TextEncoder().encode(String(s))));
  const deUtf8 = arr => (tieneBuffer ? Buffer.from(sinSigno(arr)).toString('utf8') : new TextDecoder('utf-8').decode(sinSigno(arr)));
  const aBase64 = arr => (tieneBuffer ? Buffer.from(sinSigno(arr)).toString('base64') : btoa(String.fromCharCode(...sinSigno(arr))));
  const deBase64 = s => (tieneBuffer ? conSigno(Buffer.from(String(s), 'base64')) : conSigno(Uint8Array.from(atob(String(s)), c => c.charCodeAt(0))));
  function digest(s) {
    if (nodeCrypto) return conSigno(nodeCrypto.createHash('sha256').update(String(s), 'utf8').digest());
    const out = []; let h = 2166136261;   // navegador: FNV (solo sirve de llave de caché)
    for (let k = 0; k < 32; k++) { for (const ch of String(s) + k) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } out.push((h & 255) - 128); }
    return out;
  }
  function parsearCsv(texto) {
    const filas = []; let fila = [], cur = '', q = false;
    const cerrar = () => { fila.push(cur); cur = ''; if (fila.length > 1 || fila[0] !== '') filas.push(fila); fila = []; };
    for (let i = 0; i < texto.length; i++) {
      const c = texto[i];
      if (q) { if (c === '"' && texto[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { fila.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && texto[i + 1] === '\n') i++; cerrar(); }
      else cur += c;
    }
    if (cur !== '' || fila.length) cerrar();
    return filas;
  }
  const respuesta = (code, body) => ({ getResponseCode: () => code, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });

  // UrlFetchApp que truena como el real. manejar(url, o) devuelve la respuesta (o truena por red).
  // En fetchAll se mandan todas las peticiones (como el real, van a la vez) y, si alguna tronó,
  // la excepción sale al final: las demás sí llegaron a Salesforce.
  function urlFetchFiel(manejar) {
    const una = (url, o = {}) => {
      const u = String(url);
      if (u.length > 2048) throw new Error('Limit Exceeded: URLFetch URL Length (' + u.length + ' caracteres).');
      const r = manejar(u, o);
      const code = r.getResponseCode();
      if (code >= 400 && o.muteHttpExceptions !== true) {
        throw new Error('Request failed for ' + u.split('?')[0] + ' returned code ' + code + '. Truncated server response: ' + String(r.getContentText()).slice(0, 100));
      }
      return r;
    };
    return {
      fetch: una,
      fetchAll(reqs) {
        let error = null;
        const out = reqs.map(r => { try { return una(r.url, r); } catch (e) { error = error || e; return null; } });
        if (error) throw error;
        return out;
      }
    };
  }

  function crearGoogleFalso(opciones = {}) {
    const g = {
      opciones,
      ahora: opciones.ahora != null ? opciones.ahora : Date.now(),
      cache: new Map(),        // llave → valor (las pruebas pueden leerlo, ponerlo y borrarlo)
      venceCache: new Map(),   // llave → ms en que vence
      cachePuts: 0,
      spreadsheets: new Map(),
      archivos: new Map(),     // id → archivo de Drive (Sheets incluidos)
      carpetas: new Map(),
      tokens: new Map(),       // id_token → respuesta de tokeninfo
      cuentaScript: opciones.cuentaScript || 'script.catalyst@docplanner.com',
      creados: 0
    };
    g.avanzar = ms => { g.ahora += ms; return g.ahora; };
    const auditId = opciones.auditSheetId || 'sheet_prueba';

    // ── CacheService ──
    const cache = {
      get(k) {
        if (!g.cache.has(k)) return null;
        if (g.venceCache.has(k) && g.venceCache.get(k) <= g.ahora) { g.cache.delete(k); g.venceCache.delete(k); return null; }
        return g.cache.get(k);
      },
      put(k, v, seg) {
        k = String(k); v = String(v);
        if (k.length > 250) throw new Error('Argument too large: key (' + k.length + ' caracteres)');
        const bytes = utf8(v).length;
        if (bytes > 100 * 1024) throw new Error('Argument too large: value (' + bytes + ' bytes)');
        const ttl = Math.min(21600, Math.max(1, seg == null ? 600 : Number(seg)));
        g.cache.set(k, v); g.venceCache.set(k, g.ahora + ttl * 1000); g.cachePuts++;
      },
      remove(k) { g.cache.delete(k); g.venceCache.delete(k); }
    };

    // ── LockService ──
    const ocupado = () => (typeof g.opciones.lockOcupado === 'function' ? !!g.opciones.lockOcupado() : !!g.opciones.lockOcupado);
    g.locks = { pedidos: 0, negados: 0 };
    const lock = () => {
      let tengo = false;
      return {
        tryLock() { g.locks.pedidos++; if (ocupado()) { g.locks.negados++; return false; } tengo = true; return true; },
        waitLock() { g.locks.pedidos++; if (ocupado()) { g.locks.negados++; throw new Error('Lock timeout: another process was holding the lock for too long.'); } tengo = true; },
        releaseLock() { tengo = false; },
        hasLock: () => tengo
      };
    };

    // ── Hojas y Sheets ──
    function crearHoja(nombre, datos) {
      const h = { nombre, datos: datos || [] };
      const ultima = () => { for (let i = h.datos.length - 1; i >= 0; i--) if ((h.datos[i] || []).some(c => c !== '' && c != null)) return i + 1; return 0; };
      const rango = (fila, col, n = 1, m = 1) => {
        const r = {
          getValues: () => Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => { const f = h.datos[fila - 1 + i]; const v = f ? f[col - 1 + j] : undefined; return v == null ? '' : v; })),
          getValue: () => r.getValues()[0][0],
          setValues(mat) {
            if (mat.length !== n || mat.some(f => f.length !== m)) throw new Error('The number of rows or columns in the data does not match the range.');
            mat.forEach((f, i) => { const k = fila - 1 + i; while (h.datos.length <= k) h.datos.push([]); f.forEach((v, j) => { h.datos[k][col - 1 + j] = v; }); });
            return r;
          },
          setValue(v) { return r.setValues([[v]]); },
          clearContent() { return r.setValues(Array.from({ length: n }, () => Array(m).fill(''))); }
        };
        ['setFontWeight', 'setBackground', 'setFontColor', 'setFontSize'].forEach(f => { r[f] = () => r; });
        return r;
      };
      Object.assign(h, {
        getName: () => h.nombre,
        getLastRow: ultima,
        appendRow(fila) { h.datos.length = ultima(); h.datos.push(fila.slice()); return h; },
        getRange: rango,
        deleteRow(n) { h.datos.splice(n - 1, 1); },
        setFrozenRows() {}, setColumnWidth() {}, autoResizeColumns() {}
      });
      return h;
    }
    function crearSpreadsheet(id, nombre, hojas) {
      const ss = { id, nombre, hojas };
      Object.assign(ss, {
        getId: () => ss.id,
        getName: () => ss.nombre,
        getUrl: () => 'https://docs.google.com/spreadsheets/d/' + ss.id + '/edit',
        getSheets: () => ss.hojas.slice(),
        getSheetByName: n => ss.hojas.find(h => h.nombre === n) || null,
        insertSheet(n) {
          if (ss.hojas.some(h => h.nombre === n)) throw new Error('A sheet with the name "' + n + '" already exists.');
          const h = crearHoja(n); ss.hojas.push(h); return h;
        },
        deleteSheet(h) {
          if (ss.hojas.length === 1) throw new Error('No puedes quitar todas las hojas de un documento.');
          ss.hojas = ss.hojas.filter(x => x !== h);
        }
      });
      g.spreadsheets.set(id, ss);
      return ss;
    }

    // ── Drive ──
    const usuario = email => ({ getEmail: () => email });
    function archivo(datos) {
      const a = Object.assign({ owner: g.cuentaScript, editores: [], padres: [], trashed: false }, datos);
      Object.assign(a, {
        getId: () => a.id, getName: () => a.nombre, setName(n) { a.nombre = n; const ss = g.spreadsheets.get(a.id); if (ss) ss.nombre = n; return a; },
        getOwner: () => usuario(a.owner),
        getEditors: () => a.editores.map(usuario),
        setOwner(email) {
          if (g.opciones.setOwnerFalla) throw new Error('No se puede transferir la propiedad a ' + email);
          if (a.owner !== email) { a.editores = a.editores.filter(e => e !== email); a.editores.push(a.owner); a.owner = email; }
          return a;
        },
        moveTo(c) { a.padres = [c.id]; return a; },
        setTrashed(b) { a.trashed = !!b; return a; },
        getParents() { const ids = a.padres.slice(); return { hasNext: () => ids.length > 0, next: () => g.carpetas.get(ids.shift()) }; }
      });
      g.archivos.set(a.id, a);
      return a;
    }
    function carpeta(datos) {
      const c = Object.assign({ owner: g.cuentaScript, editores: [], visores: [] }, datos);
      Object.assign(c, {
        getId: () => c.id, getName: () => c.nombre, getUrl: () => 'https://drive.google.com/drive/folders/' + c.id,
        getOwner: () => usuario(c.owner), getEditors: () => c.editores.map(usuario), getViewers: () => c.visores.map(usuario)
      });
      g.carpetas.set(c.id, c);
      return c;
    }
    g.agregarCarpeta = carpeta;
    g.agregarArchivo = archivo;
    // Un Sheet que ya existe en Drive (p. ej. el del usuario para adjuntar el export)
    g.agregarSheet = ({ id, nombre = 'Sheet ' + id, owner, editores = [], hojas = ['Hoja 1'] }) => {
      archivo({ id, nombre, owner: owner || g.cuentaScript, editores, mime: 'application/vnd.google-apps.spreadsheet' });
      return crearSpreadsheet(id, nombre, hojas.map(n => crearHoja(n)));
    };

    // El Sheet de auditoría: su primera hoja es g.auditoria (las pruebas la leen directo)
    g.auditoria = [];
    g.agregarSheet({ id: auditId, nombre: 'Auditoría Cat-alyst', owner: g.cuentaScript });
    g.spreadsheets.get(auditId).hojas[0] = crearHoja(opciones.nombreHojaAuditoria || 'Log', g.auditoria);
    g.hoja = (ssId, nombre) => { const ss = g.spreadsheets.get(ssId || auditId); return ss && ss.getSheetByName(nombre); };
    carpeta({ id: opciones.carpetaId || 'carpeta_prueba', nombre: 'COE Exports', editores: ['usuario.prueba@docplanner.com', 'admin.prueba@docplanner.com'] });

    const nuevoId = pref => pref + '_falso_' + String(++g.creados).padStart(4, '0') + 'xxxxxxxxxxxx';
    const sinAcceso = id => new Error('No se encontró el elemento con el ID "' + id + '" o no tienes permiso para abrirlo.');

    // ── tokeninfo y Drive v3 falsos (lo que Code.gs pide a googleapis) ──
    g.registrarToken = (token, info) => { g.tokens.set(token, info); };
    g.google = (url, o = {}) => {
      const u = String(url);
      if (/oauth2\.googleapis\.com\/tokeninfo/.test(u)) {
        const f = g.opciones.tokeninfoFalla;
        if (f === 'excepcion') throw new Error('Address unavailable: https://oauth2.googleapis.com/tokeninfo');
        if (f) return respuesta(f, '{"error":"temporal"}');
        const t = decodeURIComponent(u.split('id_token=')[1] || '');
        return g.tokens.has(t) ? respuesta(200, g.tokens.get(t)) : respuesta(400, '{"error":"invalid_token"}');
      }
      const m = u.match(/googleapis\.com\/drive\/v3\/files\/([^/]+)\/copy/);
      if (m && String(o.method).toLowerCase() === 'post') {
        const orig = g.archivos.get(m[1]);
        if (!orig) return respuesta(404, '{"error":"notFound"}');
        const cuerpo = JSON.parse(o.payload || '{}');
        const id = nuevoId('xlsx');
        archivo({ id, nombre: cuerpo.name || orig.nombre, mime: 'application/vnd.google-apps.spreadsheet' });
        crearSpreadsheet(id, cuerpo.name || orig.nombre, [crearHoja('Hoja 1', parsearCsv(orig.contenido || ''))]);
        return respuesta(200, { id });
      }
      return respuesta(404, 'ruta desconocida en Google falso: ' + u);
    };

    g.globales = {
      Logger: { log() {} },
      Utilities: {
        DigestAlgorithm: { SHA_256: 'sha256' },
        Charset: { UTF_8: 'utf8' },
        computeDigest: (alg, s) => digest(s),
        base64EncodeWebSafe: arr => aBase64(arr).replace(/\+/g, '-').replace(/\//g, '_'),
        base64DecodeWebSafe: s => deBase64(String(s).replace(/-/g, '+').replace(/_/g, '/')),
        base64Decode: s => deBase64(s),
        newBlob(datos, mime, nombre) {
          const bytes = typeof datos === 'string' ? utf8(datos) : Array.from(datos || []);
          return { getDataAsString: () => deUtf8(bytes), getBytes: () => bytes.slice(), getContentType: () => mime || '', getName: () => nombre || '' };
        },
        parseCsv: t => parsearCsv(String(t)),
        getUuid: () => {
          if (nodeCrypto && nodeCrypto.randomUUID) return nodeCrypto.randomUUID();
          return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16));
        },
        sleep() {}
      },
      CacheService: { getScriptCache: () => cache },
      LockService: { getScriptLock: lock },
      SpreadsheetApp: {
        openById(id) {
          const ss = g.spreadsheets.get(id), a = g.archivos.get(id);
          if (!ss || (a && a.trashed)) throw sinAcceso(id);
          return ss;
        },
        create(nombre) {
          if (g.opciones.crearSheetFalla) throw new Error('Servicio de Hojas de cálculo no disponible.');
          const id = nuevoId('ss');
          archivo({ id, nombre, mime: 'application/vnd.google-apps.spreadsheet' });
          return crearSpreadsheet(id, nombre, [crearHoja('Hoja 1')]);
        }
      },
      DriveApp: {
        getFileById(id) { const a = g.archivos.get(id); if (!a) throw sinAcceso(id); return a; },
        getFolderById(id) { const c = g.carpetas.get(id); if (!c) throw sinAcceso(id); return c; },
        createFile(blob) {
          return archivo({ id: nuevoId('file'), nombre: blob.getName(), mime: blob.getContentType(), contenido: blob.getDataAsString() });
        }
      },
      ScriptApp: { getOAuthToken: () => 'token-falso-del-script' },
      Session: { getEffectiveUser: () => usuario(g.cuentaScript) },
      ContentService: {
        MimeType: { JSON: 'json', TEXT: 'text' },
        createTextOutput(c) {
          const o = { contenido: c == null ? '' : String(c), mime: '' };
          o.setMimeType = m => { o.mime = m; return o; };
          o.setContent = x => { o.contenido = String(x); return o; };
          o.getContent = () => o.contenido;
          return o;
        }
      }
    };
    return g;
  }

  const api = { crearGoogleFalso, urlFetchFiel, respuesta, parsearCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.GoogleFalso = api;
})(typeof window !== 'undefined' ? window : globalThis);
