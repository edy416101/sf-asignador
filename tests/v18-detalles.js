// v18.4 · Detalles de uso: copiar con saltos de línea, panel admin sin tronar y "Días" igual en
// la pantalla y en el export. El teclado (Esc, foco, pestañas) se prueba en el simulador.
const assert = require('assert');
const { cargarFunciones, cargarBackend, serviciosGoogleFalsos } = require('./lib/cargar');
const { urlFetchFiel } = require('./lib/google-falso');

module.exports = function (html, prueba, setGrupo) {
  setGrupo('v18.4 · Detalles de uso');
  prueba('copiar: una celda con salto de línea, tab o comillas va entre comillas (se pega en UNA celda)', () => {
    const celda = cargarFunciones(html, ['celdaTsv'], 'celdaTsv');
    assert.strictEqual(celda('Clinica\nSur'), '"Clinica\nSur"');
    assert.strictEqual(celda('5" pantalla'), '"5"" pantalla"');
    assert.strictEqual(celda('a\tb'), '"a\tb"');
    assert.strictEqual(celda('normal'), 'normal');
    assert.strictEqual(celda(null), '');
  });
  prueba('panel admin: un log que no llegó completo no truena la pantalla', () => {
    const els = {};
    const document = { getElementById: id => (els[id] = els[id] || { value: '', textContent: '', innerHTML: '' }) };
    const render = cargarFunciones(html, ['esc', 'admFecha', 'renderLogAdmin'], 'renderLogAdmin', { document, adminCache: { log: null } });
    render();
    const render2 = cargarFunciones(html, ['esc', 'admFecha', 'renderLogAdmin'], 'renderLogAdmin',
      { document, adminCache: { log: [{ ts: 0, email: null, op: 'import', estado: 'success', det: null }] } });
    els.admFiltroTexto.value = 'x';
    render2();
  });
  prueba('el Summary del Sheet dice "0 (solo hoy)" para días 0, igual que la pantalla', () => {
    const g = serviciosGoogleFalsos();
    const ctx = cargarBackend(urlFetchFiel(g.google), process.env.CODE_GS || null, g.globales);
    const ss = g.globales.SpreadsheetApp.create('x');
    ctx.llenarTresHojas(ss, { meta: { dias: 0 }, ownerStats: [] }, [], [], [], []);
    const v = ss.getSheetByName('Summary').getRange(1, 1, 8, 2).getValues().flat();
    assert.ok(v.includes('0 (solo hoy)'), JSON.stringify(v));
  });
  prueba('el log y el CSV del export usan el mismo texto para días 0', () => {
    assert.ok(/'0 \(solo hoy\)'/.test(html) && !/'Sin filtro'/.test(html));
  });
};
