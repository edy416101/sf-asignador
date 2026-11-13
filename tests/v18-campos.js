// v18 · Datos al campo correcto: funciones reales de index.html (sin navegador). Los flujos de
// pantalla (custom fields, mapeo, país, recuperar) se prueban en el simulador (SIM.correr).
const assert = require('assert');
const { cargarFunciones: cargarAhora } = require('./lib/cargar');
const cargar = (...a) => { let fn = null; return (...b) => (fn = fn || cargarAhora(...a))(...b); };

module.exports = function (html, prueba, setGrupo) {
  setGrupo('v18 · Datos al campo correcto: validación antes de mandar');
  const validar = cargar(html, ['validarFilasImport'], 'validarFilasImport', {
    RE_ID_USER: /^005[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/,
    RE_ID_CONTACT: /^003[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/,
    RE_EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    RE_FECHA: /^\d{4}-\d{2}-\d{2}$/,
    RE_FECHA_HORA: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/,
    TIPOS_CON_LARGO: new Set(['string', 'textarea', 'email', 'phone', 'url', 'picklist', 'multipicklist']),
    CAMPOS_OBLIGATORIOS_LEAD: new Set(['Contact__c', 'LastName', 'Email', 'OwnerId', 'BusinessLine__c', 'Lead_Type__c',
      'ContactTypeSegment__c', 'Country__c', 'Leadassist__Use_Round_Robin__c', 'Status'])
  });
  const H = ['LastName', 'OwnerId', 'Country__c', 'FacilitySize__c', 'Leadassist__Use_Round_Robin__c', 'NumberOfEmployees', 'Tags__c', 'Email'];
  const META = {
    LastName: { type: 'string', nillable: false, createable: true, length: 80 },
    OwnerId: { type: 'reference', nillable: false, createable: true },
    Country__c: { type: 'picklist', restrictedPicklist: true, picklistValues: ['Mexico', 'Peru', 'Argentina'] },
    FacilitySize__c: { type: 'picklist', restrictedPicklist: false, picklistValues: ['Small', 'Mid'] },
    Leadassist__Use_Round_Robin__c: { type: 'boolean', nillable: false },
    NumberOfEmployees: { type: 'int' },
    Tags__c: { type: 'multipicklist', restrictedPicklist: true, picklistValues: ['A', 'B'] },
    Email: { type: 'email', nillable: true }
  };
  const fila = o => H.map(h => (h in o ? o[h] : { LastName: 'Pérez', OwnerId: '005P400000FpACnIAN', Country__c: 'Peru', FacilitySize__c: 'Mid',
    Leadassist__Use_Round_Robin__c: 'FALSE', NumberOfEmployees: '12', Tags__c: 'A;B', Email: 'a@b.mx' }[h]));
  prueba('una fila correcta pasa (país PE como "Peru", mayúsculas distintas en el picklist también)', () => {
    const e = validar(H, [fila({}), fila({ Country__c: 'peru' })], META);
    assert.strictEqual(e.length, 0, JSON.stringify(e));
    assert.strictEqual(e.avisos.length, 0);
  });
  prueba('país fuera del picklist restringido → bloquea con el número de fila', () => {
    const e = validar(H, [fila({}), fila({ Country__c: 'Peruu' })], META);
    assert.deepStrictEqual(e.map(x => [x.fila, x.campo]), [[2, 'Country__c']]);
    assert.ok(/no está en la lista/.test(e[0].motivo));
  });
  prueba('picklist NO restringido fuera de la lista → aviso (no bloquea)', () => {
    const e = validar(H, [fila({ FacilitySize__c: 'Huge' })], META);
    assert.strictEqual(e.length, 0);
    assert.strictEqual(e.avisos[0].campo, 'FacilitySize__c');
  });
  prueba('multipicklist: cada valor separado por ; se revisa', () => {
    assert.strictEqual(validar(H, [fila({ Tags__c: 'A;Z' })], META)[0].campo, 'Tags__c');
  });
  prueba('booleano que no es TRUE/FALSE y número que no es número → bloquean', () => {
    const e = validar(H, [fila({ Leadassist__Use_Round_Robin__c: 'SI', NumberOfEmployees: '12 personas' })], META);
    assert.deepStrictEqual(e.map(x => x.campo).sort(), ['Leadassist__Use_Round_Robin__c', 'NumberOfEmployees']);
  });
  prueba('obligatorio de negocio vacío (Email, Country__c) → aviso antes de mandar', () => {
    const e = validar(H, [fila({ Email: '', Country__c: '' })], META);
    assert.strictEqual(e.length, 0);
    assert.deepStrictEqual(e.avisos.map(x => x.campo).sort(), ['Country__c', 'Email']);
  });

  setGrupo('v18 · Datos al campo correcto: carga manual y resultado recuperado');
  const PT = ['Contact__c', 'LastSourceAt__c', 'Company', 'LastName', 'Email', 'OwnerId', 'BusinessLine__c', 'Lead_Type__c',
    'ContactTypeSegment__c', 'Country__c', 'Leadassist__Use_Round_Robin__c', 'Status', 'FacilitySize__c'];
  const analizar = cargar(html, ['normalizarHeader', 'analizarCarga'], 'analizarCarga', {
    MIN_REQUIRED_LOAD: ['Contact__c', 'LastName', 'Email', 'OwnerId'], VALID_FIELD_REGEX: /^[A-Za-z][A-Za-z0-9_]*$/, PT_HEADERS_BASE: PT, customFields: []
  });
  const enc = ['Contact__c', 'LastName', 'Email', 'OwnerId', '__Status', '__Id', '__Action', '__Errors'];
  const res = (c, st) => [c, 'Doc', 'd@t.mx', '005P400000FpACnIAN', st, st === 'Succeeded' ? '00Q1' : '', '', ''];
  prueba('cargar un import_result.csv trae solo las filas Failed (las creadas o en proceso no)', () => {
    const a = analizar([enc, res('003A00000000001', 'Succeeded'), res('003A00000000002', 'Failed'), res('003A00000000003', 'En proceso')], PT);
    assert.strictEqual(a.esResultado, true);
    assert.deepStrictEqual(a.filas.map(f => f[0]), ['003A00000000002']);
    assert.strictEqual(a.omitidasResultado, 2);
  });
  prueba('Contact__c repetidos (15 y 18 caracteres) se cuentan para avisar', () => {
    const a = analizar([['Contact__c', 'LastName', 'Email', 'OwnerId'], ['003A00000000001', 'x', 'a@b.mx', '005P400000FpACnIAN'],
      ['003A00000000001AAA', 'y', 'b@b.mx', '005P400000FpACnIAN'], ['003A00000000002', 'z', 'c@b.mx', '005P400000FpACnIAN']], PT);
    assert.strictEqual(a.contactosRepetidos, 1);
  });
  const encabezados = cargar(html, ['parseDelimitado', 'encabezadosResultado'], 'encabezadosResultado', { PT_HEADERS: PT });
  prueba('recuperar tras recargar: las columnas del resultado son las de su import (custom incluidas)', () => {
    const h = encabezados({ resultHeaders: [...PT, 'Campaign_Code__c', '__Status', '__Id', '__Action', '__Errors'] }, []);
    assert.ok(h.includes('Campaign_Code__c'));
  });
  prueba('…y sin la config del import, salen del CSV de Salesforce', () => {
    const h = encabezados(null, ['"sf__Id","sf__Created","Contact__c","Campaign_Code__c"\n"00Q1","true","003A","X"\n']);
    assert.ok(h.includes('Campaign_Code__c') && !h.includes('sf__Id'), h.join(','));
    assert.deepStrictEqual(h.slice(-4), ['__Status', '__Id', '__Action', '__Errors']);
  });
};
