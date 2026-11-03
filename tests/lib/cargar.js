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

// Corre backend/Code.gs en una caja aislada con un UrlFetchApp falso (nunca sale a la red)
function cargarBackend(UrlFetchApp, ruta) {
  const code = fs.readFileSync(ruta || path.join(RAIZ, 'backend', 'Code.gs'), 'utf8').replace(/^﻿/, '');
  const ctx = vm.createContext({ UrlFetchApp, Logger: { log() {} } });
  vm.runInContext(code, ctx);
  return ctx;
}

module.exports = { RAIZ, leerIndex, extraerFuncion, cargarFunciones, cargarBackend };
