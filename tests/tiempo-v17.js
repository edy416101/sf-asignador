// Tiempo simulado de un import: el Salesforce falso tarda como el real (~1.15 s por Lead,
// transacciones de 200 en serie dentro de cada job, jobs distintos a la vez). Se corre el
// Code.gs real y se sondea con los mismos intervalos que index.html. El reloj es simulado:
// la prueba tarda milisegundos y no toca nada real.
//
// Lo que NO mide: el tiempo de crear los jobs y de bajar resultados (~20 s en total), los
// bloqueos entre jobs y si Salesforce de verdad corre todos los jobs a la vez. Para eso sigue
// haciendo falta una carga real.
const assert = require('assert');
const { cargarBackend, serviciosGoogleFalsos } = require('./lib/cargar');
const { crearBulkFalso } = require('./lib/bulk-falso');

const INSTANCIA = 'https://docplanner.my.salesforce.com';
const HEADERS = ['Contact__c', 'Company', 'LastName', 'Email', 'OwnerId'];
const owner = k => '005P4000' + String(k).padStart(7, '0') + 'AAA';
const filas = (n, ownerDe) => Array.from({ length: n }, (_, i) =>
  ['003TEST' + String(i).padStart(8, '0'), 'Clinica ' + i, 'Doc' + i, 'doc' + i + '@test.local', owner(ownerDe(i))]);

// Intervalos de sondeo del frontend real
function intervalos(html) {
  const v = n => Number((html.match(new RegExp('const ' + n + '\\s*=\\s*(\\d+)')) || [])[1]);
  return { rapido: v('POLL_RAPIDO_MS'), lento: v('POLL_LENTO_MS'), cambio: v('POLL_CAMBIO_MS') };
}

// Corre un import de `rows` y sondea hasta que termina. Devuelve minutos simulados y el progreso visto.
function medir(html, rows, { unSoloJob = false } = {}) {
  const bulk = crearBulkFalso({ reloj: {} });
  const g = serviciosGoogleFalsos();
  const ctx = cargarBackend(bulk.UrlFetchApp, process.env.CODE_GS || null, g.globales);
  if (unSoloJob) ctx.FILAS_POR_JOB = 100000;   // así trabajaba v16: un solo job con todo
  const r = ctx.iniciarImportBulk({ sid: 'SID', instanceUrl: INSTANCIA, object: 'Lead', operation: 'insert',
    headers: HEADERS, rows, userEmail: 'usuario.prueba@docplanner.com', clientRequestId: 'req_tiempo_' + (++nMedicion) });
  const p = intervalos(html);
  const progreso = [];
  let t = 0, est;
  do {
    const espera = t < p.cambio ? p.rapido : p.lento;
    bulk.avanzar(espera); t += espera;
    est = ctx.consultarEstadoJob({ sid: 'SID', instanceUrl: INSTANCIA, jobIds: r.jobIds });
    progreso.push({ t, processed: est.processed });
  } while (!est.terminado && t < 60 * 60 * 1000);
  return { min: t / 60000, jobs: r.jobIds.length, est, progreso };
}

const fmt = m => m.toFixed(1) + ' min';
let nMedicion = 0;

module.exports = function (html, prueba, setGrupo) {
  setGrupo('v17 · Tiempo simulado (Salesforce falso a ~1.15 s por Lead)');
  const p = intervalos(html);

  prueba('el index.html tiene los intervalos de sondeo que usa esta prueba', () => {
    assert.ok(p.rapido > 0 && p.lento > 0 && p.cambio > 0, JSON.stringify(p));
  });

  // 500 filas repartidas entre 10 reps (50 cada uno)
  const diezReps = filas(500, i => i % 10);
  const v16 = medir(html, diezReps, { unSoloJob: true });
  const v17 = medir(html, diezReps);

  prueba('calibración: 500 filas en un solo job tardan como el job real (~10 min) → ' + fmt(v16.min), () => {
    assert.strictEqual(v16.jobs, 1);
    assert.ok(v16.min >= 9 && v16.min <= 11, fmt(v16.min));
  });
  prueba('el progreso sube por bloques de 200, como en Salesforce', () => {
    const vistos = [...new Set(v16.progreso.map(x => x.processed))];
    assert.deepStrictEqual(vistos, [0, 200, 400, 500]);
  });
  prueba('v17 con 10 reps: 5 jobs a la vez → ' + fmt(v17.min) + ' (vs ' + fmt(v16.min) + ')', () => {
    assert.strictEqual(v17.jobs, 5);
    assert.strictEqual(v17.est.processed, 500);
    assert.ok(v17.min <= 2.5, fmt(v17.min));
    assert.ok(v16.min / v17.min >= 4, 'solo ' + (v16.min / v17.min).toFixed(1) + ' veces más rápido');
  });

  // Casos que dependen de cuántos reps trae la carga (cada owner va entero a un solo job)
  const dosReps = medir(html, filas(500, i => i % 2));
  prueba('v17 con 2 reps: 2 jobs de 250 → ' + fmt(dosReps.min) + ' (gana menos: un owner no se parte)', () => {
    assert.strictEqual(dosReps.jobs, 2);
    assert.ok(dosReps.min <= 5.5, fmt(dosReps.min));
  });
  const unRep = medir(html, filas(500, () => 0));
  prueba('v17 con 1 rep: 1 solo job → ' + fmt(unRep.min) + ' (igual que antes)', () => {
    assert.strictEqual(unRep.jobs, 1);
    assert.ok(Math.abs(unRep.min - v16.min) < 0.5, fmt(unRep.min));
  });
};
