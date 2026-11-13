// Candado de red para las pruebas de Node: cualquier intento de salir a internet truena.
// Solo se permite localhost (el simulador y Chrome headless corren ahí).
// Se carga al inicio de tests/run.js y tests/todo.js. `intentos` guarda lo que se cortó.
const http = require('http');
const https = require('https');
const net = require('net');

const LOCALES = ['localhost', '127.0.0.1', '::1', ''];
const intentos = [];

function hostDe(destino) {
  if (!destino) return '';
  if (typeof destino === 'string' || destino instanceof URL) {
    try { return new URL(String(destino)).hostname.replace(/^\[|\]$/g, ''); } catch (e) { return String(destino); }
  }
  return String(destino.hostname || destino.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
}

function cortar(donde, host) {
  intentos.push(donde + ' → ' + host);
  throw new Error('Candado de red: las pruebas no pueden salir a internet (' + donde + ' → ' + host + ')');
}

for (const [nombre, mod] of [['http', http], ['https', https]]) {
  for (const fn of ['request', 'get']) {
    const original = mod[fn];
    mod[fn] = function (destino, ...resto) {
      const host = hostDe(destino);
      if (!LOCALES.includes(host)) cortar(nombre + '.' + fn, host);
      return original.call(this, destino, ...resto);
    };
  }
}

const connectOriginal = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = Array.isArray(args[0]) ? args[0][0] : args[0];   // net.connect() pasa sus argumentos ya normalizados
  const host = typeof o === 'object' && o !== null ? (o.host || 'localhost') : (typeof args[1] === 'string' ? args[1] : 'localhost');
  if (typeof o === 'object' && o !== null && o.path) return connectOriginal.apply(this, args);   // pipes locales
  if (!LOCALES.includes(String(host).replace(/^\[|\]$/g, ''))) cortar('socket', host);
  return connectOriginal.apply(this, args);
};

if (typeof globalThis.fetch === 'function') {
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = function (destino, ...resto) {
    const host = hostDe(destino && destino.url ? destino.url : destino);
    if (!LOCALES.includes(host)) { try { cortar('fetch', host); } catch (e) { return Promise.reject(e); } }
    return fetchOriginal.call(this, destino, ...resto);
  };
}

module.exports = { intentos, LOCALES };
