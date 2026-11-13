// Pruebas v17 del frontend: funciones reales de index.html, sin navegador ni red.
const assert = require('assert');
const { cargarFunciones: cargarAhora, extraerFuncion } = require('./lib/cargar');
// Carga perezosa: si una función no existe en esa versión de index.html (p. ej. la de
// main al comparar), falla solo la prueba que la usa, no todo el archivo.
const cargarFunciones = (...args) => { let fn = null; return (...a) => (fn = fn || cargarAhora(...args))(...a); };

module.exports = function (html, prueba, setGrupo) {
  const RESULT_HDRS = ['Contact__c', 'Company', 'LastName', 'OwnerId', '__Status', '__Id', '__Action', '__Errors'];

  // ── Parser único ──────────────────────────────────────────────
  setGrupo('v17 · Parser CSV/TSV único');
  const parseDelimitado = cargarFunciones(html, ['parseDelimitado'], 'parseDelimitado');
  const detectarDelimitador = cargarFunciones(html, ['detectarDelimitador'], 'detectarDelimitador');
  prueba('TSV pegado de Sheets: una celda con salto de línea no parte la fila', () => {
    const tsv = 'Contact__c\tCompany\tLastName\r\n003A\t"Clinica\nSur"\tPérez\r\n003B\tNorte\tLópez\r\n';
    const m = parseDelimitado(tsv, '\t');
    assert.strictEqual(m.length, 3);
    assert.strictEqual(m[1][1], 'Clinica\nSur');
    assert.deepStrictEqual(m[2], ['003B', 'Norte', 'López']);
  });
  prueba('comillas escapadas, delimitador dentro de comillas y comilla suelta a mitad de celda', () => {
    const m = parseDelimitado('a,b\n"x, ""y""",5" pantalla\n', ',');
    assert.deepStrictEqual(m[1], ['x, "y"', '5" pantalla']);
  });
  prueba('tabs dentro de comillas en TSV y BOM al inicio', () => {
    const m = parseDelimitado('﻿a\tb\n"uno\tdos"\ttres\n', '\t');
    assert.deepStrictEqual(m[0], ['a', 'b']);
    assert.deepStrictEqual(m[1], ['uno\tdos', 'tres']);
  });
  prueba('detecta ; en CSV de Excel en español', () => {
    assert.strictEqual(detectarDelimitador('Contact__c;LastName;Email\n003;"a,b";c'), ';');
    assert.strictEqual(detectarDelimitador('"a;b",c,d\n'), ',');
  });

  // ── Detección de headers ──────────────────────────────────────
  setGrupo('v17 · Carga manual: headers que no se confunden con datos');
  const PT = ['Contact__c', 'LastSourceAt__c', 'Company', 'LastName', 'Email', 'OwnerId', 'BusinessLine__c', 'Lead_Type__c',
    'ContactTypeSegment__c', 'Country__c', 'Leadassist__Use_Round_Robin__c', 'Status', 'FacilitySize__c'];
  const customFields = [];
  const analizarCarga = cargarFunciones(html, ['normalizarHeader', 'analizarCarga'], 'analizarCarga', {
    MIN_REQUIRED_LOAD: ['Contact__c', 'LastName', 'Email', 'OwnerId'],
    VALID_FIELD_REGEX: /^[A-Za-z][A-Za-z0-9_]*$/,
    PT_HEADERS_BASE: PT,
    customFields
  });
  prueba('una fila de datos (Mexico, FALSE, Assigned…) NO se toma como headers', () => {
    const datos = [['0031100000ABCDE', 'Clinica', 'Perez', 'a@b.mx', '005P400000FpACn', 'Agenda Premium', 'New Business', 'DOCTOR', 'Mexico', 'FALSE', 'Assigned']];
    const a = analizarCarga(datos, PT);
    assert.strictEqual(a.hayHeaders, false);
    assert.deepStrictEqual([...a.nuevosCustom], []);
    assert.strictEqual(a.filas.length, 1);
  });
  prueba('con 2 headers conocidos sí hay headers, y un custom nuevo se detecta', () => {
    const a = analizarCarga([['Contact__c', 'LastName', 'Email', 'OwnerId', 'Suffix__c'], ['003X', 'P', 'a@b.mx', '005Y', 'Dr']], PT);
    assert.strictEqual(a.hayHeaders, true);
    assert.deepStrictEqual([...a.nuevosCustom], ['Suffix__c']);
    assert.strictEqual(a.filas[0][a.ptPreview.indexOf('Suffix__c')], 'Dr');
  });
  prueba('la vista previa no toca customFields (antes los agregaba al vuelo)', () => {
    analizarCarga([['Contact__c', 'LastName', 'Otro__c'], ['003X', 'P', 'v']], PT);
    assert.strictEqual(customFields.length, 0);
  });
  prueba('valores con espacios a los lados se recortan', () => {
    const a = analizarCarga([['Contact__c', 'OwnerId'], ['  003X  ', '005Y ']], PT);
    assert.strictEqual(a.filas[0][PT.indexOf('Contact__c')], '003X');
    assert.strictEqual(a.filas[0][PT.indexOf('OwnerId')], '005Y');
  });

  // ── Validación de filas ───────────────────────────────────────
  setGrupo('v17 · Validación de filas antes de enviar');
  const validar = cargarFunciones(html, ['validarFilasImport'], 'validarFilasImport', {
    RE_ID_USER: /^005[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/,
    RE_ID_CONTACT: /^003[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/,
    RE_EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    RE_FECHA: /^\d{4}-\d{2}-\d{2}$/,
    RE_FECHA_HORA: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/,
    TIPOS_CON_LARGO: new Set(['string', 'textarea', 'email', 'phone', 'url', 'picklist', 'multipicklist'])
  });
  const H = ['Contact__c', 'LastName', 'Company', 'Email', 'OwnerId', 'LastSourceAt__c', 'Leadassist__Use_Round_Robin__c'];
  const META = {
    LastName: { type: 'string', nillable: false, createable: true, length: 80 },
    Company: { type: 'string', nillable: false, createable: true, length: 255 },
    Email: { type: 'email', nillable: true, createable: true, length: 80 },
    OwnerId: { type: 'reference', nillable: false, createable: true },
    LastSourceAt__c: { type: 'datetime', nillable: true, createable: true },
    Leadassist__Use_Round_Robin__c: { type: 'boolean', nillable: false, createable: true },
    Contact__c: { type: 'reference', nillable: true, createable: true }
  };
  const buena = ['0031100000ABCDE', 'Pérez', 'Clinica', 'a@b.mx', '005P400000FpACnIAN', '2026-11-12T10:00:00.000+0000', ''];
  prueba('una fila correcta pasa (booleano vacío no cuenta como obligatorio)', () => {
    assert.deepStrictEqual([...validar(H, [buena], META)], []);
  });
  prueba('detecta obligatorio vacío, OwnerId mal, email mal y fecha mal, con número de fila', () => {
    const mala = ['0031100000ABCDE', '', 'Clinica', 'sin-arroba', '0057Q', '12/11/2026', ''];
    const e = validar(H, [buena, mala], META);
    assert.deepStrictEqual(e.map(x => x.campo).sort(), ['Email', 'LastName', 'LastSourceAt__c', 'OwnerId']);
    assert.ok(e.every(x => x.fila === 2));
  });
  prueba('un campo con valor por defecto en Salesforce (Status) no cuenta como obligatorio', () => {
    const e = validar(['LastName', 'Status'], [['Pérez', '']], { LastName: META.LastName, Status: { type: 'picklist', nillable: false, createable: true, defaultedOnCreate: true } });
    assert.strictEqual(e.length, 0);
  });
  prueba('sin describe: al menos OwnerId y LastName', () => {
    const e = validar(['LastName', 'OwnerId'], [['', '123']], null);
    assert.deepStrictEqual(e.map(x => x.campo), ['LastName', 'OwnerId']);
  });
  prueba('Contact__c que no es un Contact (003…) se rechaza', () => {
    const e = validar(['Contact__c'], [['001AAAAAAAAAAAA']], null);
    assert.strictEqual(e.length, 1);
  });

  // ── Doble clic ────────────────────────────────────────────────
  setGrupo('v17 · Doble clic y candado del import');
  function fuenteImport(importEnCurso) {
    const els = {};
    const el = id => (els[id] = els[id] || { classList: { add() {}, remove() {} }, textContent: '', innerHTML: '', disabled: true });
    let mapeos = 0;
    const fn = cargarFunciones(html, ['actualizarFuenteImport'], 'actualizarFuenteImport', {
      document: { getElementById: el }, preTemplateRows: [[1]], totalAsignados: 1, PT_HEADERS: ['a'],
      importEnCurso, buildFieldMapping: () => { mapeos++; }
    });
    fn();
    return { boton: els.importBtn, mapeos };
  }
  prueba('a mitad de un import, actualizarFuenteImport NO reactiva el botón', () => {
    const r = fuenteImport(true);
    assert.strictEqual(r.boton.disabled, true);
    assert.strictEqual(r.mapeos, 0);
  });
  prueba('sin import en curso, el botón se activa como antes', () => {
    assert.strictEqual(fuenteImport(false).boton.disabled, false);
  });
  prueba('ejecutarImport, ejecutarRetry y ejecutarRecuperar revisan el candado', () => {
    ['ejecutarImport', 'ejecutarRetry', 'ejecutarRecuperar'].forEach(n => {
      const a = html.indexOf('async function ' + n + '(');
      const cuerpo = html.slice(a, html.indexOf('\n}\n', a));
      assert.ok(/if \(importEnCurso\)/.test(cuerpo) && /importEnCurso = true/.test(cuerpo) && /importEnCurso = false/.test(cuerpo), n);
    });
  });
  prueba('importStart siempre manda clientRequestId', () => {
    const a = html.indexOf("action: 'importStart'");
    assert.ok(a > 0 && /clientRequestId: nuevoRequestId\(\)/.test(html.slice(a, a + 300)));
  });

  // ── Resultados y retry ────────────────────────────────────────
  setGrupo('v17 · Resultados y retry');
  const parseSfResultCsv = cargarFunciones(html, ['parseDelimitado', 'parseSfResultCsv'], 'parseSfResultCsv', { IMPORT_RESULT_HEADERS: RESULT_HDRS });
  prueba('columna mapeada a otro API Name: el resultado la regresa a su columna', () => {
    const csv = '"sf__Id","sf__Created","Contact__c","Empresa__c"\n"00Q1","true","003X","Clinica Sur"\n';
    const f = parseSfResultCsv(csv, 'ok', 'insert', { Contact__c: 'Contact__c', Empresa__c: 'Company' })[0];
    assert.strictEqual(f.Company, 'Clinica Sur');
  });
  prueba('filas no procesadas (unprocessedrecords) salen como fallidas con motivo', () => {
    const f = parseSfResultCsv('"Contact__c","LastName"\n"003X","P"\n', 'unprocessed', 'insert', {})[0];
    assert.strictEqual(f.__Status, 'Failed');
    assert.ok(/UNPROCESSED/.test(f.__Errors));
  });
  const fila = (c, ln, st, err) => ({ Contact__c: c, Company: 'X', LastName: ln, OwnerId: '005', __Status: st, __Id: '', __Action: '', __Errors: err || '' });
  // mergeRetryResult reasigna la variable global importResultRows: se arma con una
  // variable local y se devuelve lo que quedó en ella.
  function merge(filasAntes, ok, fail, colNames) {
    const fuente = 'let importResultRows = filasAntes; const ultimoImportConfig = null; const PT_HEADERS = [];\n' +
      extraerFuncion(html, 'llaveFila') + '\n' + extraerFuncion(html, 'mergeRetryResult') +
      '\nmergeRetryResult(ok, fail, 1, colNames); return importResultRows;';
    return new Function('filasAntes', 'ok', 'fail', 'colNames', fuente)(filasAntes, ok, fail, colNames);
  }
  prueba('merge del retry con Contact__c repetido: cada fila recibe su propio resultado', () => {
    const antes = [fila('003X', 'Ana', 'Failed', 'e1'), fila('003X', 'Beto', 'Failed', 'e2'), fila('003Z', 'Caro', 'Succeeded')];
    const ok = [{ ...fila('003X', 'Beto', 'Succeeded'), __Id: '00QB', __Action: 'Inserted' }];
    const fail = [{ ...fila('003X', 'Ana', 'Failed', 'sigue') }];
    const r = merge(antes, ok, fail, ['Contact__c', 'Company', 'LastName', 'OwnerId']);
    assert.strictEqual(r[0].__Status, 'Failed'); assert.strictEqual(r[0].__Errors, 'sigue');
    assert.strictEqual(r[1].__Status, 'Succeeded'); assert.strictEqual(r[1].__Id, '00QB');
    assert.strictEqual(r[2].__Status, 'Succeeded');
  });
  prueba('merge del retry sin columna Contact__c', () => {
    const antes = [{ LastName: 'Ana', __Status: 'Failed' }, { LastName: 'Beto', __Status: 'Failed' }];
    const r = merge(antes, [{ LastName: 'Beto', __Status: 'Succeeded', __Id: '00QB', __Action: 'Inserted' }], [], ['LastName']);
    assert.deepStrictEqual(r.map(x => x.__Status), ['Failed', 'Succeeded']);
  });

  // ── Seguridad en el navegador ─────────────────────────────────
  setGrupo('v17 · Escapes y descargas');
  const esc = cargarFunciones(html, ['esc'], 'esc');
  const csvCelda = cargarFunciones(html, ['csvCelda'], 'csvCelda');
  prueba("esc() escapa ' (antes rompía los onclick='…')", () => {
    assert.strictEqual(esc(`a'b"<c>&`), 'a&#39;b&quot;&lt;c&gt;&amp;');
  });
  prueba('descargas CSV: fórmulas neutralizadas, teléfonos y negativos intactos', () => {
    assert.strictEqual(csvCelda('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.strictEqual(csvCelda('@SUM(A1)'), `"'@SUM(A1)"`);
    assert.strictEqual(csvCelda('+cmd|calc'), `"'+cmd|calc"`);
    assert.strictEqual(csvCelda('+52 55 1234 5678'), '"+52 55 1234 5678"');
    assert.strictEqual(csvCelda('-5'), '"-5"');
  });
  prueba('el log ya no mete HTML (usa textContent)', () => {
    const a = html.indexOf('function escribirLog(');
    const cuerpo = html.slice(a, html.indexOf('\n}\n', a));
    assert.ok(/textContent/.test(cuerpo) && !/innerHTML \+=/.test(cuerpo));
    assert.ok(!/\nfunction ilog\([^)]*\) \{\n/.test(html), 'quedó el ilog viejo');
  });
  prueba('SheetJS 0.20.x con SRI', () => {
    assert.ok(/xlsx-0\.20\.\d+\/package\/dist\/xlsx\.full\.min\.js" integrity="sha384-/.test(html));
  });
};
