// Bulk API 2.0 FALSA en memoria (jobs/ingest). La usan las pruebas de Node y el simulador para
// correr iniciarImportBulk / consultarEstadoJob / recuperarResultadoJob de Code.gs sin red.
// Se porta como Salesforce en lo que puede crear Leads duplicados: un job cerrado no se puede
// cerrar otra vez (400 INVALIDJOBSTATE), abortar no deshace lo que ya se creó y una excepción
// de red puede llegar DESPUÉS de que Salesforce hizo el cambio.
//
// opciones:
//   sesionVencida      → todo responde 401
//   falloCrear: [i]    → la creación del job número i (0, 1, …) responde 500
//   falloSubida: [i]   → la subida del CSV del job i responde 500
//   falloCierre: [i]   → cerrar (UploadComplete) el job i responde 500 sin cerrarlo (solo la 1a vez)
//   cierreMiente: [i]  → cerrar el job i SÍ lo cierra (y se procesa), pero responde 500
//   falloDescarga      → 'successfulResults' | 'failedResults' | 'unprocessedrecords' responde 500
//   falloJob(j)        → texto (o { mensaje, procesadas }) para que el job termine en Failed con
//                        ese errorMessage; sus filas sin procesar salen en unprocessedrecords
//   excepcion(p)       → p = { metodo, ruta, paso, job }; devuelve 'antes' (la petición no llega)
//                        o 'despues' (Salesforce la procesa y la respuesta se pierde): truena
//                        como una caída de red de UrlFetchApp
//   sondeosParaTerminar→ cuántos GET de estado antes de pasar a JobComplete (default 0)
//   lock(fila)         → true si esa fila choca por bloqueo la PRIMERA vez que se procesa
//   lockEnvuelto       → el bloqueo llega envuelto en otro error (como cuando lo dispara un trigger)
//   rechazo(fila)      → texto de error de validación para esa fila, o '' si pasa
//   reloj              → { msPorLead, filasPorTransaccion }: los jobs tardan como en Salesforce.
//                        Cada job procesa sus filas en transacciones de 200, una tras otra, a
//                        ~1.15 s por Lead (medido en el job real de 500 que tardó 10.5 min).
//                        Los jobs distintos corren a la vez. El tiempo es simulado: b.avanzar(ms)
//                        lo mueve y b.ahora lo dice; nunca se espera de verdad.
// Con operation 'upsert', una fila cuyo External ID ya existe se actualiza (sf__Created=false).
(function (raiz) {
  const G = (typeof module !== 'undefined' && module.exports) ? require('./google-falso') : raiz.GoogleFalso;
  const parsearCsv = G.parsearCsv;
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = (hdr, filas) => [hdr.map(q).join(',')].concat(filas.map(f => f.map(q).join(','))).join('\n') + '\n';
  function to18(id15) {
    const map = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    let s = '';
    for (let i = 0; i < 3; i++) {
      let f = 0;
      for (let j = 0; j < 5; j++) { const c = id15[i * 5 + j]; if (c >= 'A' && c <= 'Z') f += 1 << j; }
      s += map[f];
    }
    return id15 + s;
  }
  const ERROR_LOCK = 'UNABLE_TO_LOCK_ROW:unable to obtain exclusive access to this record:--';
  const ERROR_LOCK_ENVUELTO = 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY:LeadTrigger: execution of AfterInsert caused by: ' +
    'System.DmlException: Update failed. First exception on row 0; first error: UNABLE_TO_LOCK_ROW, unable to obtain exclusive access to this record: []:--';
  const estadoInvalido = (j, nuevo) => [{ errorCode: 'INVALIDJOBSTATE', message: 'Changing state of a job from ' + j.state + ' to ' + nuevo + ' is not allowed.' }];

  function crearBulkFalso(opciones = {}) {
    const b = { jobs: [], llamadas: [], creados: [], actualizados: [], lockVistos: new Set(), opciones, ahora: 0, porExterno: new Map() };
    const reloj = opciones.reloj ? Object.assign({ msPorLead: 1150, filasPorTransaccion: 200 }, opciones.reloj) : null;
    b.avanzar = ms => { b.ahora += ms; return b.ahora; };
    b.ERROR_LOCK = ERROR_LOCK; b.ERROR_LOCK_ENVUELTO = ERROR_LOCK_ENVUELTO;
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
    const resp = G.respuesta;
    const job = id => b.jobs.find(j => j.id === id);

    function procesar(j) {
      const m = parsearCsv(j.csv || '');
      const hdr = m[0] || [];
      j.ok = []; j.fail = []; j.sinProcesar = []; j.hdr = hdr;
      let datos = m.slice(1);
      const falla = opciones.falloJob ? opciones.falloJob(j) : '';
      if (falla) {
        const procesadas = typeof falla === 'object' ? (falla.procesadas || 0) : 0;
        j.errorMessage = typeof falla === 'object' ? falla.mensaje : falla;
        j.sinProcesar = datos.slice(procesadas);
        datos = datos.slice(0, procesadas);
      }
      const ext = j.cuerpo.operation === 'upsert' ? j.cuerpo.externalIdFieldName : '';
      datos.forEach(vals => {
        const fila = {}; hdr.forEach((h, i) => { fila[h] = vals[i] ?? ''; });
        const llave = fila.Contact__c || vals.join('|');
        let error = '';
        if (opciones.lock && opciones.lock(fila) && !b.lockVistos.has(llave)) {
          b.lockVistos.add(llave);
          error = opciones.lockEnvuelto ? ERROR_LOCK_ENVUELTO : ERROR_LOCK;
        } else if (opciones.rechazo) error = opciones.rechazo(fila) || '';
        if (error) { j.fail.push(['', error, ...vals]); return; }
        if (ext && fila[ext] && b.porExterno.has(fila[ext])) {
          const id = b.porExterno.get(fila[ext]);
          j.ok.push([id, 'false', ...vals]);
          b.actualizados.push({ id, fila, jobId: j.id });
          return;
        }
        const id = to18('00QFAKE' + String(++seqLead).padStart(8, '0'));
        j.ok.push([id, 'true', ...vals]);
        b.creados.push({ id, fila, jobId: j.id });
        if (ext && fila[ext]) b.porExterno.set(fila[ext], id);
      });
    }

    function ejecutar(metodo, ruta, o) {
      let m;
      if (metodo === 'post' && ruta === '/jobs/ingest') {
        const i = b.jobs.length;
        if ((opciones.falloCrear || []).includes(i)) return resp(500, [{ errorCode: 'UNKNOWN_EXCEPTION', message: 'error al crear' }]);
        const cuerpo = JSON.parse(o.payload);
        const id = to18('750FAKE' + String(i + 1).padStart(8, '0'));
        b.jobs.push({ id, i, state: 'Open', cuerpo, sondeos: 0, ok: [], fail: [], sinProcesar: [],
          createdDate: new Date(Date.now() + b.ahora).toISOString().replace('Z', '+0000') });
        return resp(200, { id, state: 'Open', object: cuerpo.object, operation: cuerpo.operation });
      }
      if ((m = ruta.match(/^\/jobs\/ingest\/(750\w+)\/batches$/)) && metodo === 'put') {
        const j = job(m[1]);
        if (!j) return resp(404, [{ errorCode: 'NOT_FOUND' }]);
        if (j.state !== 'Open') return resp(400, estadoInvalido(j, 'Open'));
        if ((opciones.falloSubida || []).includes(j.i)) return resp(500, [{ errorCode: 'UNKNOWN_EXCEPTION', message: 'error al subir' }]);
        j.csv = o.payload;
        return resp(201, '');
      }
      if ((m = ruta.match(/^\/jobs\/ingest\/(750\w+)$/)) && metodo === 'patch') {
        const j = job(m[1]);
        if (!j) return resp(404, [{ errorCode: 'NOT_FOUND' }]);
        const nuevo = JSON.parse(o.payload).state;
        if (nuevo === 'Aborted') {
          // Abortar no deshace: lo que Salesforce ya procesó queda creado.
          if (!['Open', 'UploadComplete', 'InProgress'].includes(j.state)) return resp(400, estadoInvalido(j, nuevo));
          if (j.state === 'Open') {
            const m2 = parsearCsv(j.csv || '');
            j.hdr = m2[0] || []; j.sinProcesar = m2.slice(1);
          }
          j.state = 'Aborted';
          return resp(200, { id: j.id, state: 'Aborted' });
        }
        if (nuevo === 'UploadComplete') {
          if (j.state !== 'Open') return resp(400, estadoInvalido(j, nuevo));
          if ((opciones.falloCierre || []).includes(j.i) && !j.cierreFallado) { j.cierreFallado = true; return resp(500, [{ errorCode: 'UNKNOWN_EXCEPTION', message: 'error al cerrar' }]); }
          if (!j.csv) return resp(400, [{ errorCode: 'INVALIDJOBSTATE', message: 'No data uploaded' }]);
          j.state = 'UploadComplete'; j.inicio = b.ahora; procesar(j);
          if (j.errorMessage) j.state = 'Failed';
          if ((opciones.cierreMiente || []).includes(j.i)) return resp(500, [{ errorCode: 'UNKNOWN_EXCEPTION', message: 'timeout interno' }]);
          return resp(200, { id: j.id, state: 'UploadComplete' });
        }
        return resp(400, estadoInvalido(j, nuevo));
      }
      if ((m = ruta.match(/^\/jobs\/ingest\/(750\w+)$/)) && metodo === 'get') {
        const j = job(m[1]);
        if (!j) return resp(404, [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }]);
        if (reloj && (j.state === 'UploadComplete' || j.state === 'InProgress')) {
          const n = j.ok.length + j.fail.length;
          j.state = filasHechas(j) >= n ? 'JobComplete' : 'InProgress';
          if (j.state === 'JobComplete' && j.fin == null) j.fin = j.inicio + n * reloj.msPorLead;
        } else if (!reloj && j.state === 'UploadComplete' && ++j.sondeos > (opciones.sondeosParaTerminar || 0)) j.state = 'JobComplete';
        const procesado = ['JobComplete', 'Failed', 'Aborted'].includes(j.state);
        const hechas = reloj && j.state === 'InProgress' ? filasHechas(j) : (procesado ? j.ok.length + j.fail.length : 0);
        const d = {
          id: j.id, state: j.state, object: j.cuerpo.object, operation: j.cuerpo.operation,
          externalIdFieldName: j.cuerpo.externalIdFieldName,
          numberRecordsProcessed: hechas,
          numberRecordsFailed: procesado ? j.fail.length : 0,
          retries: 0, apexProcessingTime: procesado ? 1000 * hechas : 0,
          totalProcessingTime: procesado ? 1100 * hechas : 0,
          createdDate: j.createdDate
        };
        if (j.state === 'Failed') d.errorMessage = j.errorMessage;
        return resp(200, d);
      }
      if ((m = ruta.match(/^\/jobs\/ingest\/(750\w+)\/(successfulResults|failedResults|unprocessedrecords)\/?$/))) {
        const j = job(m[1]);
        if (!j) return resp(404, [{ errorCode: 'NOT_FOUND' }]);
        if (opciones.falloDescarga === m[2]) return resp(500, [{ errorCode: 'UNKNOWN_EXCEPTION', message: 'error al descargar' }]);
        const hdr = j.hdr || parsearCsv(j.csv || '')[0] || [];
        if (m[2] === 'successfulResults') return resp(200, csv(['sf__Id', 'sf__Created', ...hdr], j.ok || []));
        if (m[2] === 'failedResults') return resp(200, csv(['sf__Id', 'sf__Error', ...hdr], j.fail || []));
        return resp(200, csv(hdr, j.sinProcesar || []));
      }
      return resp(404, 'ruta desconocida en la Bulk API falsa: ' + metodo + ' ' + ruta);
    }

    function manejar(url, o = {}) {
      const metodo = String(o.method || 'get').toLowerCase();
      b.llamadas.push(metodo.toUpperCase() + ' ' + url);
      if (opciones.sesionVencida) return resp(401, [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }]);
      const ruta = String(url).replace(/^https:\/\/[^/]+\/services\/data\/v[\d.]+/, '');
      const idJob = (ruta.match(/^\/jobs\/ingest\/(750\w+)/) || [])[1];
      let paso = 'otro';
      if (metodo === 'post') paso = 'crear';
      else if (metodo === 'put') paso = 'subir';
      else if (metodo === 'patch') paso = /Aborted/.test(o.payload || '') ? 'abortar' : 'cerrar';
      else if (/Results|unprocessed/.test(ruta)) paso = 'descargar';
      else if (metodo === 'get') paso = 'estado';
      const caida = opciones.excepcion ? opciones.excepcion({ metodo, ruta, paso, job: idJob ? job(idJob) : null, i: b.jobs.length }) : '';
      if (caida === 'antes') throw new Error('Address unavailable: ' + url);
      const r = ejecutar(metodo, ruta, o);
      if (caida) throw new Error('Exception: Timeout: ' + url);
      return r;
    }

    b.UrlFetchApp = G.urlFetchFiel(manejar);
    return b;
  }

  const api = { crearBulkFalso, parsearCsv, to18 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.BulkFalso = api;
})(typeof window !== 'undefined' ? window : globalThis);
