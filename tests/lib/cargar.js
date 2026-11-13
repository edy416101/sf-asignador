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
// Viven en tests/lib/google-falso.js (los comparte el simulador del navegador). Devuelve el
// objeto g: g.globales (para cargarBackend), g.auditoria (filas del Sheet de auditoría),
// g.cache (llave → valor), g.avanzar(ms) para mover el reloj del caché y más (ver el archivo).
function serviciosGoogleFalsos(opciones) {
  return require('./google-falso').crearGoogleFalso(opciones || {});
}

// Corre backend/Code.gs en una caja aislada con un UrlFetchApp falso (nunca sale a la red).
// `extras` agrega globales (p. ej. los servicios de serviciosGoogleFalsos()).
function cargarBackend(UrlFetchApp, ruta, extras) {
  const code = fs.readFileSync(ruta || path.join(RAIZ, 'backend', 'Code.gs'), 'utf8').replace(/^﻿/, '');
  const ctx = vm.createContext(Object.assign({ UrlFetchApp, Logger: { log() {} } }, extras || {}));
  // v17.1: la configuración privada vive fuera de git; las pruebas usan una falsa.
  vm.runInContext(fs.readFileSync(path.join(RAIZ, 'tests', 'lib', 'config-prueba.gs'), 'utf8'), ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

module.exports = { RAIZ, leerIndex, extraerFuncion, cargarFunciones, cargarBackend, serviciosGoogleFalsos };
