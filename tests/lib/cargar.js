// Carga el código REAL de Cat-alyst para probarlo en Node, sin navegador y sin red.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = path.resolve(__dirname, '..', '..');

// Texto de index.html (por defecto el del repo; se puede pasar otra ruta para probar otra versión)
function leerIndex(ruta) {
  return fs.readFileSync(ruta || path.join(RAIZ, 'index.html'), 'utf8').split('\r').join('');
}

// Saca el texto de `function nombre(...) { ... }` del index.html. '' si no existe en esa versión.
function extraerFuncion(html, nombre) {
  const a = html.indexOf('\nfunction ' + nombre + '(');
  if (a < 0) return '';
  const b = html.indexOf('\n}\n', a);
  return html.slice(a + 1, b + 2);
}

// Arma un módulo con las funciones pedidas (las que no existan se omiten) y devuelve `exportar`.
// `globales` son los nombres que esas funciones leen de la página (p. ej. document).
function cargarFunciones(html, nombres, exportar, globales = {}) {
  const fuentes = nombres.map(n => extraerFuncion(html, n)).filter(Boolean).join('\n');
  const claves = Object.keys(globales);
  return new Function(...claves, fuentes + '\nreturn ' + exportar + ';')(...claves.map(k => globales[k]));
}

// Servicios de Google falsos (en memoria) para correr Code.gs fuera de Apps Script.
// Utilities usa crypto/Buffer de Node; CacheService y LockService viven en memoria;
// SpreadsheetApp guarda las filas de auditoría en `auditoria`.
function serviciosGoogleFalsos() {
  const crypto = require('crypto');
  const cache = new Map();
  const auditoria = [];
  const hojaAuditoria = {
    getLastRow: () => auditoria.length,
    appendRow: fila => auditoria.push(fila),
    getRange: (fila, col, n, ncols) => ({
      setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; },
      getValues: () => auditoria.slice(fila - 1, fila - 1 + n).map(f => f.slice(col - 1, col - 1 + (ncols || 1)))
    }),
    setFrozenRows() {}, setColumnWidth() {}
  };
  const bytes = buf => [...buf].map(b => (b > 127 ? b - 256 : b));
  const buffer = arr => Buffer.from(arr.map(b => b & 255));
  return {
    auditoria,
    cache,
    globales: {
      Utilities: {
        DigestAlgorithm: { SHA_256: 'sha256' },
        Charset: { UTF_8: 'utf8' },
        computeDigest: (alg, s) => bytes(crypto.createHash(alg).update(String(s), 'utf8').digest()),
        base64EncodeWebSafe: arr => buffer(arr).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
        base64DecodeWebSafe: s => bytes(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
        newBlob: arr => ({ getDataAsString: () => buffer(arr).toString('utf8') }),
        getUuid: () => crypto.randomUUID()
      },
      CacheService: { getScriptCache: () => ({
        get: k => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { cache.set(k, String(v)); },
        remove: k => { cache.delete(k); }
      }) },
      LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
      SpreadsheetApp: { openById: () => ({ getSheets: () => [hojaAuditoria], getSheetByName: () => null }) },
      ContentService: {
        MimeType: { JSON: 'json' },
        createTextOutput: () => { const o = { contenido: '' }; o.setMimeType = () => o; o.setContent = c => { o.contenido = c; return o; }; return o; }
      }
    }
  };
}

// Corre backend/Code.gs en una caja aislada con un UrlFetchApp falso (nunca sale a la red).
// `extras` agrega globales (p. ej. los servicios de serviciosGoogleFalsos()).
function cargarBackend(UrlFetchApp, ruta, extras) {
  const code = fs.readFileSync(ruta || path.join(RAIZ, 'backend', 'Code.gs'), 'utf8').replace(/^﻿/, '');
  const ctx = vm.createContext(Object.assign({ UrlFetchApp, Logger: { log() {} } }, extras || {}));
  vm.runInContext(code, ctx);
  return ctx;
}

module.exports = { RAIZ, leerIndex, extraerFuncion, cargarFunciones, cargarBackend, serviciosGoogleFalsos };
