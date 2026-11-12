// Pruebas de Cat-alyst SIN tocar nada real: corren el código real (index.html y backend/Code.gs)
// contra un Salesforce falso en memoria. No hay SID, no hay red.
//
// Uso:  node tests/run.js                      → prueba el index.html del repo
//       node tests/run.js ruta/a/otro/index.html → prueba otra versión (p. ej. antes/después)
const assert = require('assert');
const { leerIndex, cargarFunciones, cargarBackend } = require('./lib/cargar');
const SF = require('./lib/sf-falso');

const html = leerIndex(process.argv[2]);
const resultados = [];
let grupo = '';
function prueba(nombre, fn) {
  try { fn(); resultados.push({ grupo, nombre, ok: true }); }
  catch (e) { resultados.push({ grupo, nombre, ok: false, error: e.message }); }
}

// ── Frontend: caja "IDs de Contactos" ───────────────────────────
// getIds() lee la caja con document; aquí le damos un document falso con el texto pegado.
function leerIds(texto) {
  const document = { getElementById: () => ({ value: texto }) };
  const getIds = cargarFunciones(html, ['dedupIds', 'getIds'], 'getIds', { document });
  const r = getIds();
  return Array.isArray(r) ? { ids: r, duplicados: null } : r;   // versiones viejas devuelven solo el array
}
const descartados = r => {
  assert.ok(r.duplicados, 'esta versión no cuenta duplicados descartados');
  return r.duplicados.length;
};

grupo = 'IDs de Contactos (deduplicación)';
const A18 = SF.REAL, A15 = A18.slice(0, 15);
prueba('mismo ID 3 veces → queda 1 y se descartan 2', () => {
  const r = leerIds([A18, A18, A18].join('\n'));
  assert.deepStrictEqual(r.ids, [A18]);
  assert.strictEqual(descartados(r), 2);
});
prueba('mismo ID en 15 y en 18 caracteres → queda 1', () => {
  assert.strictEqual(leerIds([A15, A18].join('\n')).ids.length, 1);
});
prueba('IDs que solo difieren en mayúsculas → quedan 2', () => {
  assert.strictEqual(leerIds([A18, SF.REAL_OTRA_MAYUS].join('\n')).ids.length, 2);
});
prueba('líneas vacías y espacios no cuentan como IDs ni como duplicados', () => {
  const r = leerIds('\r\n   \r\n  ' + A18 + '  \r\n\t\r\n');
  assert.deepStrictEqual(r.ids, [A18]);
  assert.strictEqual(descartados(r), 0);
});
prueba('comillas alrededor del ID se quitan', () => {
  assert.deepStrictEqual(leerIds('"' + A18 + '"\n\'' + A15 + '\'').ids, [A18]);
});
prueba('lista sin duplicados → misma lista, en el mismo orden', () => {
  const lista = ['003TEST00000001', A18, '003P400000AbCdEFGH'];
  const r = leerIds(lista.join('\n'));
  assert.deepStrictEqual(r.ids, lista);
  assert.strictEqual(descartados(r), 0);
});
prueba('se conserva la primera aparición', () => {
  assert.deepStrictEqual(leerIds(['003TEST00000009', A18, '003TEST00000009', A15].join('\n')).ids, ['003TEST00000009', A18]);
});
prueba('IDs con largo distinto de 15/18 pasan sin tocar y no cuentan como duplicados', () => {
  const r = leerIds(['abc', 'abc', A18 + 'X'].join('\n'));
  assert.deepStrictEqual(r.ids, ['abc', 'abc', A18 + 'X']);
  assert.strictEqual(descartados(r), 0);
});

// ── Frontend: resultado del import (CSV de Bulk API 2.0) ────────
const HEADERS_RESULTADO = ['Contact__c', 'Company', 'LastName', 'Country__c', 'OwnerId', '__Status', '__Id', '__Action', '__Errors'];
const parseSfResultCsv = cargarFunciones(html, ['parseCsvRecords', 'parseCsvRow', 'parseSfResultCsv'], 'parseSfResultCsv', { IMPORT_RESULT_HEADERS: HEADERS_RESULTADO });
const q = v => '"' + String(v).replace(/"/g, '""') + '"';
const HDR_FALLIDOS = ['sf__Id', 'sf__Error', 'Contact__c', 'Company', 'LastName', 'Country__c', 'OwnerId'].map(q).join(',');
const filaFallida = (error, company) => ['', error, '0031100000ABCDEFGH', company, 'Carlos Guerrero', 'Mexico', '005P400000FpACnIAN'].map(q).join(',');
function unaFilaCompleta(csv) {
  const filas = parseSfResultCsv(csv, false, 'insert');
  assert.strictEqual(filas.length, 1, 'se esperaba 1 fila y salieron ' + filas.length);
  const f = filas[0];
  assert.strictEqual(f.Contact__c, '0031100000ABCDEFGH', 'Contact__c fuera de su columna');
  assert.strictEqual(f.LastName, 'Carlos Guerrero', 'LastName fuera de su columna');
  assert.strictEqual(f.OwnerId, '005P400000FpACnIAN', 'OwnerId fuera de su columna');
  assert.strictEqual(f.__Status, 'Failed');
  return f;
}

grupo = 'Resultado del import (filas con error)';
prueba('error de Salesforce con salto de línea → fila completa, error en un renglón', () => {
  const f = unaFilaCompleta(HDR_FALLIDOS + '\n' + filaFallida('VALIDATION:El lead ya existe.\nRevisa el contacto:--', 'Clinica Sur') + '\n');
  assert.strictEqual(f.__Errors, 'VALIDATION:El lead ya existe. Revisa el contacto:--');
});
prueba('salto de línea dentro de un dato (Company) → el dato se conserva', () => {
  const f = unaFilaCompleta(HDR_FALLIDOS + '\n' + filaFallida('VALIDATION:x:--', 'Clinica\nSur') + '\n');
  assert.strictEqual(f.Company, 'Clinica\nSur');
});
prueba('comas y comillas dentro de los valores', () => {
  const f = unaFilaCompleta(HDR_FALLIDOS + '\n' + filaFallida('VALIDATION:x, con coma:--', 'Clinica "La Paz", Sur') + '\n');
  assert.strictEqual(f.Company, 'Clinica "La Paz", Sur');
  assert.strictEqual(f.__Errors, 'VALIDATION:x, con coma:--');
});
prueba('finales CRLF y líneas vacías', () => {
  unaFilaCompleta(HDR_FALLIDOS + '\r\n\r\n' + filaFallida('VALIDATION:x:--', 'X') + '\r\n\r\n');
});
prueba('filas exitosas: Status, Id y Action', () => {
  const csv = ['sf__Id', 'sf__Created', 'Contact__c'].map(q).join(',') + '\n' + ['00Q1', 'true', '0031100000ABCDEFGH'].map(q).join(',') + '\n';
  const f = parseSfResultCsv(csv, true, 'insert')[0];
  assert.deepStrictEqual([f.__Status, f.__Id, f.__Action, f.Contact__c], ['Succeeded', '00Q1', 'Inserted', '0031100000ABCDEFGH']);
});

// ── Asignación de punta a punta: frontend + Code.gs real + Salesforce falso ──
grupo = 'Asignación de punta a punta (Code.gs real, Salesforce falso)';
const sf = SF.crearSalesforceFalso();
const backend = cargarBackend(sf.UrlFetchApp);
const res = backend.procesarAsignacion({
  sid: 'SID-FALSO', instanceUrl: 'https://salesforce.falso', dias: 0, businessLine: 'Agenda Premium', leadType: 'New Business',
  reps: Object.keys(SF.USUARIOS).map(email => ({ email, cuota: 50 })),
  ids: leerIds(SF.idsDeReporte()).ids,
  extraFields: [], fieldsFromSF: [], camposFijosOcultos: [], fieldsManualValues: {}
});
const iC = res.headers.indexOf('Contact__c'), iO = res.headers.indexOf('OwnerId');
const ownersPorContacto = {};
res.rows.forEach(r => { const k = String(r[iC]).slice(0, 15); (ownersPorContacto[k] = ownersPorContacto[k] || []).push(r[iO]); });

prueba('ningún Contact__c repetido en el pre-template', () => {
  const rep = Object.entries(ownersPorContacto).filter(([, o]) => o.length > 1).map(([k, o]) => SF.to18(k) + ' → ' + o.join(', '));
  assert.deepStrictEqual(rep, [], 'repetidos: ' + rep.join(' | '));
});
prueba('el caso real (' + SF.REAL + ') queda en una sola fila', () => {
  assert.strictEqual((ownersPorContacto[SF.REAL.slice(0, 15)] || []).length, 1);
});
prueba('el contacto que difiere en una mayúscula también se asigna', () => {
  assert.strictEqual((ownersPorContacto[SF.REAL_OTRA_MAYUS.slice(0, 15)] || []).length, 1);
});
prueba('la exclusión del query sigue funcionando (contacto con opp abierta fuera)', () => {
  assert.ok(!ownersPorContacto[SF.CON_OPP_ABIERTA]);
});
prueba('todas las filas tienen el OwnerId de un rep y ningún bloque falló', () => {
  const validos = new Set(Object.values(SF.USUARIOS));
  assert.ok(res.rows.every(r => validos.has(r[iO])));
  assert.strictEqual(res.bloquesFallidos, 0);
});

// ── v17 · Backend: import en paralelo, lock, idempotencia y seguridad ──
require('./backend-v17')(prueba, g => { grupo = g; });

// ── Reporte ─────────────────────────────────────────────────────
let actual = '';
resultados.forEach(r => {
  if (r.grupo !== actual) { actual = r.grupo; console.log('\n' + actual); }
  console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.nombre + (r.ok ? '' : '\n      → ' + r.error));
});
const fallas = resultados.filter(r => !r.ok).length;
console.log('\n' + (resultados.length - fallas) + ' de ' + resultados.length + ' pruebas pasaron' + (fallas ? ' — ' + fallas + ' fallaron' : '') +
  '. Llamadas al Salesforce falso: ' + sf.llamadas + ' (ninguna a sistemas reales).');
process.exitCode = fallas ? 1 : 0;
