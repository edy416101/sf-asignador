// Bulk API 2.0 FALSA en memoria (jobs/ingest). La usan las pruebas de Node para correr
// iniciarImportBulk / consultarEstadoJob / recuperarResultadoJob de Code.gs sin red.
//
// opciones:
//   sesionVencida      → todo responde 401
//   falloCrear: [i]    → la creación del job número i (0, 1, …) responde 500
//   falloSubida: [i]   → la subida del CSV del job i responde 500
//   falloDescarga      → 'successfulResults' | 'failedResults' | 'unprocessedrecords' responde 500
//   sondeosParaTerminar→ cuántos GET de estado antes de pasar a JobComplete (default 0)
//   lock(fila)         → true si esa fila choca por bloqueo la PRIMERA vez que se procesa
//   rechazo(fila)      → texto de error de validación para esa fila, o '' si pasa
//   reloj              → { msPorLead, filasPorTransaccion }: los jobs tardan como en Salesforce.
//                        Cada job procesa sus filas en transacciones de 200, una tras otra, a
//                        ~1.15 s por Lead (medido en el job real de 500 que tardó 10.5 min).
//                        Los jobs distintos corren a la vez. El tiempo es simulado: b.avanzar(ms)
//                        lo mueve y b.ahora lo dice; nunca se espera de verdad.
(function (raiz) {
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
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = (hdr, filas) => [hdr.map(q).join(',')].concat(filas.map(f => f.map(q).join(','))).join('\n') + '\n';

  function crearBulkFalso(opciones = {}) {
    const b = { jobs: [], llamadas: [], creados: [], lockVistos: new Set(), opciones, ahora: 0 };
    const reloj = opciones.reloj ? Object.assign({ msPorLead: 1150, filasPorTransaccion: 200 }, opciones.reloj) : null;
    b.avanzar = ms => { b.ahora += ms; return b.ahora; };
    // Con reloj: cuántas filas lleva el job en este momento (Salesforce las cuenta por transacción terminada)
    const filasHechas = j => {
      const n = j.ok.length + j.fail.length;
      if (!reloj) return n;
      let hechas = 0, t = j.inicio;
      for (let k = 0; k < n; k += reloj.filasPorTransaccion) {
        const tam = Math.min(reloj.filasPorTransaccion, n - k);
        t += tam * reloj.msPorLead;
        if (t <= b.ahora) hechas += tam; else break;
      }
      return hechas;
    };
    let seqLead = 0;
    const resp = (code, body) => ({ getResponseCode: () => code, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    const job = id => b.jobs.find(j => j.id === id);

    function procesar(j) {
      const m = parsearCsv(j.csv || '');
      const hdr = m[0] || [];
      j.ok = []; j.fail = []; j.hdr = hdr;
      m.slice(1).forEach(vals => {
        const fila = {}; hdr.forEach((h, i) => { fila[h] = vals[i] ?? ''; });
        const llave = fila.Contact__c || vals.join('|');
        let error = '';
        if (opciones.lock && opciones.lock(fila) && !b.lockVistos.has(llave)) {
          b.lockVistos.add(llave);
          error = 'UNABLE_TO_LOCK_ROW:unable to obtain exclusive access to this record:--';
        } else if (opciones.rechazo) error = opciones.rechazo(fila) || '';
        if (error) j.fail.push(['', error, ...vals]);
        else {
          const id = '00QFAKE' + String(++seqLead).padStart(11, '0');
          j.ok.push([id, 'true', ...vals]);
          b.creados.push({ id, fila, jobId: j.id });
        }
      });
    }

    function manejar(url, o = {}) {
      const metodo = String(o.method || 'get').toLowerCase();
      b.llamadas.push(metodo.toUpperCase() + ' ' + url);
      if (opciones.sesionVencida) return resp(401, [{ errorCode: 'INVALID_SESSION_ID' }]);
      const ruta = String(url).replace(/^https:\/\/[^/]+\/services\/data\/v[\d.]+/, '');
      let m;
      if (metodo === 'post' && ruta === '/jobs/ingest') {
        const i = b.jobs.length;
        if ((opciones.falloCrear || []).includes(i)) return resp(500, 'error al crear');
        const cuerpo = JSON.parse(o.payload);
        const id = '750FAKE' + String(i + 1).padStart(8, '0');
        b.jobs.push({ id, i, state: 'Open', cuerpo, sondeos: 0 });
        return resp(200, { id, state: 'Open' });
      }
      if ((m = ruta.match(/^\/jobs\/ingest\/(750\w+)\/batches$/)) && metodo === 'put') {
        const j = job(m[1]);
        if (!j) return resp(404, 'no existe');
        if ((opciones.falloSubida || []).includes(j.i)) return resp(500, 'error al subir');
        j.csv = o.payload;
        return resp(201, '');
      }
      if ((m = ruta.match(/^\/jobs\/ingest\/(750\w+)$/)) && metodo === 'patch') {
        const j = job(m[1]);
        if (!j) return resp(404, 'no existe');
        const nuevo = JSON.parse(o.payload).state;
        if (nuevo === 'Aborted') { j.state = 'Aborted'; return resp(200, { id: j.id, state: 'Aborted' }); }
        if (nuevo === 'UploadComplete') { j.state = 'UploadComplete'; j.inicio = b.ahora; procesar(j); return resp(200, { id: j.id, state: j.state }); }
        return resp(400, 'estado no válido');
      }
      if ((m = ruta.match(/^\/jobs\/ingest\/(750\w+)$/)) && metodo === 'get') {
        const j = job(m[1]);
        if (!j) return resp(404, [{ errorCode: 'NOT_FOUND' }]);
        if (reloj && (j.state === 'UploadComplete' || j.state === 'InProgress')) {
          const n = j.ok.length + j.fail.length;
          j.state = filasHechas(j) >= n ? 'JobComplete' : 'InProgress';
          if (j.state === 'JobComplete' && j.fin == null) j.fin = j.inicio + n * reloj.msPorLead;
        } else if (!reloj && j.state === 'UploadComplete' && ++j.sondeos > (opciones.sondeosParaTerminar || 0)) j.state = 'JobComplete';
        const terminado = j.state === 'JobComplete';
        const hechas = reloj && j.ok ? filasHechas(j) : (terminado ? j.ok.length + j.fail.length : 0);
        return resp(200, {
          id: j.id, state: j.state, object: j.cuerpo.object, operation: j.cuerpo.operation,
          externalIdFieldName: j.cuerpo.externalIdFieldName,
          numberRecordsProcessed: hechas,
          numberRecordsFailed: terminado ? j.fail.length : 0,
          retries: 0, apexProcessingTime: terminado ? 1000 * (j.ok.length + j.fail.length) : 0,
          totalProcessingTime: terminado ? 1100 * (j.ok.length + j.fail.length) : 0,
          createdDate: '2026-11-12T21:24:36.000+0000'
        });
      }
      if ((m = ruta.match(/^\/jobs\/ingest\/(750\w+)\/(successfulResults|failedResults|unprocessedrecords)$/))) {
        const j = job(m[1]);
        if (!j) return resp(404, 'no existe');
        if (opciones.falloDescarga === m[2]) return resp(500, 'error al descargar');
        const hdr = j.hdr || [];
        if (m[2] === 'successfulResults') return resp(200, csv(['sf__Id', 'sf__Created', ...hdr], j.ok || []));
        if (m[2] === 'failedResults') return resp(200, csv(['sf__Id', 'sf__Error', ...hdr], j.fail || []));
        return resp(200, csv(hdr, []));
      }
      return resp(404, 'ruta desconocida en la Bulk API falsa: ' + metodo + ' ' + ruta);
    }

    b.UrlFetchApp = {
      fetch: (url, o) => manejar(url, o),
      fetchAll: reqs => reqs.map(r => manejar(r.url, r))
    };
    return b;
  }

  const api = { crearBulkFalso, parsearCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.BulkFalso = api;
})(typeof window !== 'undefined' ? window : globalThis);
