// Salesforce FALSO en memoria. Lo usan las pruebas de Node y el simulador del navegador.
// Nunca hace llamadas de red: responde las mismas consultas SOQL que manda Code.gs.
(function (raiz) {
  const G = (typeof module !== 'undefined' && module.exports) ? require('./google-falso') : raiz.GoogleFalso;

  // Sufijo estándar de 18 caracteres (lo que Salesforce devuelve en Id)
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

  // Datos de prueba: 100 contactos genéricos + el caso real del pre-template duplicado
  // + otro contacto cuyo ID difiere solo en una mayúscula (son personas distintas).
  const REAL = '0037Q00000HRZMhQAP';
  const REAL_OTRA_MAYUS = to18('0037Q00000HRZMH');
  const CON_OPP_ABIERTA = '003TEST00000007';   // la exclusión del query debe sacarlo
  const USUARIOS = {
    'rep.a@test.local': '005P400000FpACnIAN',
    'rep.b@test.local': '005P400000Fp9aHIAR',
    'rep.c@test.local': '005P400000FpZZZIAR'
  };
  const idGenerico = i => '003TEST' + String(i).padStart(8, '0');

  // describe de Lead y Contact con tipos y picklists (como los manda Salesforce)
  const pick = (...v) => v.map(value => ({ value, label: value, active: true }));
  const campo = (name, type, extra) => Object.assign({ name, label: name, type, length: type === 'string' ? 255 : 0,
    nillable: true, createable: true, updateable: true, defaultedOnCreate: false, picklistValues: [] }, extra || {});
  const PAISES = ['Mexico', 'Spain', 'Colombia', 'Peru', 'Argentina', 'Brazil', 'Chile', 'Italy', 'Poland', 'Turkey'];
  const DESCRIBE = {
    Lead: [
      campo('Id', 'id', { createable: false, updateable: false, nillable: false }),
      campo('Contact__c', 'reference'), campo('LastSourceAt__c', 'datetime'),
      campo('Company', 'string', { nillable: false }), campo('LastName', 'string', { length: 80, nillable: false }),
      campo('Email', 'email', { length: 80 }), campo('OwnerId', 'reference', { nillable: false, defaultedOnCreate: true }),
      campo('BusinessLine__c', 'picklist', { restrictedPicklist: true, picklistValues: pick('Noa Notes', 'Agenda Premium', 'Media 360', 'Clinic Agenda', 'First Class', 'S4C/PMS') }),
      campo('Lead_Type__c', 'picklist', { restrictedPicklist: true, picklistValues: pick('New Business', 'Existing Business') }),
      campo('ContactTypeSegment__c', 'picklist', { picklistValues: pick('DOCTOR', 'FACILITY', 'OTHER') }),
      campo('Country__c', 'picklist', { restrictedPicklist: true, picklistValues: pick(...PAISES) }),
      campo('Leadassist__Use_Round_Robin__c', 'boolean', { nillable: false, defaultedOnCreate: true }),
      campo('Status', 'picklist', { nillable: false, defaultedOnCreate: true, restrictedPicklist: true,
        picklistValues: pick('New', 'Assigned', 'Qualifying', 'Closed').concat([{ value: 'Viejo', label: 'Viejo', active: false }]) }),
      campo('FacilitySize__c', 'picklist', { picklistValues: pick('Small', 'Mid', 'Large') }),
      campo('Suffix', 'string', { length: 40 }), campo('Phone', 'phone', { length: 40 }),
      campo('Campaign_Code__c', 'string', { length: 20 }), campo('NumberOfEmployees', 'int'),
      campo('Score__c', 'double'), campo('IsConverted', 'boolean', { createable: false, updateable: false })
    ],
    Contact: [
      campo('Id', 'id', { createable: false, updateable: false }), campo('LastName', 'string'), campo('Email', 'email'),
      campo('Phone', 'phone'), campo('LastSourceAt__c', 'datetime'), campo('AccountId', 'reference'),
      campo('ContactTypeSegment__c', 'picklist', { picklistValues: pick('DOCTOR', 'FACILITY', 'OTHER') }),
      campo('FacilitySize__c', 'picklist', { picklistValues: pick('Small', 'Mid', 'Large') }),
      campo('Country__c', 'picklist', { picklistValues: pick(...PAISES) }),
      campo('Specialty__c', 'string')
    ]
  };

  // opciones:
  //   sesionVencida  → todo responde 401 (el SID venció)
  //   tamPagina      → registros por página: si el query trae más, responde done:false con
  //                    nextRecordsUrl (como Salesforce, 2000 por defecto)
  //   usuarios       → { email: Id } en lugar de USUARIOS; usuariosExtra → [{ Id, Email, Username }]
  //   contactosExtra → cuántos contactos genéricos de más crear (para pruebas grandes)
  function crearSalesforceFalso(opciones = {}) {
    const contactos = new Map();   // llave: primeros 15 caracteres, como Salesforce
    const alta = (id15, nombre) => contactos.set(id15, {
      Id: to18(id15), LastName: nombre, Email: nombre.toLowerCase() + '@test.local',
      Account: { Name: 'Clinica ' + nombre }, LastSourceAt__c: null,
      ContactTypeSegment__c: 'DOCTOR', FacilitySize__c: 'Mid', Country__c: 'Mexico', Phone: '+52 55 0000 0000', Specialty__c: 'Pediatría'
    });
    for (let i = 0; i < 100 + (opciones.contactosExtra || 0); i++) alta(idGenerico(i), 'Doc' + i);
    alta(REAL.slice(0, 15), 'CarlosGuerrero');
    alta(REAL_OTRA_MAYUS.slice(0, 15), 'OtraPersona');
    const usuarios = Object.entries(opciones.usuarios || USUARIOS).map(([e, Id]) => ({ Id, Email: e, Username: e }))
      .concat(opciones.usuariosExtra || []);
    const tamPagina = opciones.tamPagina || 2000;
    const paginas = new Map();
    const resp = (code, body) => ({ getContentText: () => JSON.stringify(body), getResponseCode: () => code });

    const sf = { llamadas: 0, urls: [], contactos };
    function pagina(records, desde) {
      const resto = records.slice(desde + tamPagina);
      const out = { totalSize: records.length, done: !resto.length, records: records.slice(desde, desde + tamPagina) };
      if (resto.length) {
        const id = '01gFAKE' + String(paginas.size + 1).padStart(8, '0') + '-' + (desde + tamPagina);
        paginas.set(id, { records, desde: desde + tamPagina });
        out.nextRecordsUrl = '/services/data/v62.0/query/' + id;
      }
      return out;
    }
    function manejar(url) {
      sf.llamadas++; sf.urls.push(url);
      if (opciones.sesionVencida) return resp(401, [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }]);
      const ruta = String(url).replace(/^https:\/\/[^/]+\/services\/data\/v[\d.]+/, '');
      let m;
      if ((m = ruta.match(/^\/sobjects\/(\w+)\/describe\/?$/))) {
        if (!DESCRIBE[m[1]]) return resp(404, [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }]);
        return resp(200, { name: m[1], fields: DESCRIBE[m[1]] });
      }
      if ((m = ruta.match(/^\/query\/(01gFAKE[\w-]+)$/))) {
        const p = paginas.get(m[1]);
        return p ? resp(200, pagina(p.records, p.desde)) : resp(400, [{ errorCode: 'INVALID_QUERY_LOCATOR' }]);
      }
      const soql = decodeURIComponent(String(url).split('?q=')[1] || '');
      let records = [];
      if (/FROM User/.test(soql)) {
        const emails = [...soql.matchAll(/'([^']+)'/g)].map(x => x[1].toLowerCase());
        const vistos = new Set();
        records = usuarios.filter(u => (emails.includes(String(u.Email).toLowerCase()) || emails.includes(String(u.Username).toLowerCase())) &&
          !vistos.has(u.Id) && vistos.add(u.Id));
      } else if (/FROM Contact WHERE Id IN \(/.test(soql)) {
        const ids = [...soql.match(/FROM Contact WHERE Id IN \(([^)]*)\)/)[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
        // Igual que Salesforce: cada registro sale UNA vez por query, aunque el ID venga repetido o en 15/18
        const vistos = new Map();
        ids.forEach(id => {
          const k = id.slice(0, 15);
          if (contactos.has(k) && k !== CON_OPP_ABIERTA) vistos.set(k, contactos.get(k));
        });
        records = [...vistos.values()];
      } else return resp(400, [{ errorCode: 'MALFORMED_QUERY', message: 'consulta desconocida en el Salesforce falso' }]);
      return resp(200, pagina(records, 0));
    }
    sf.UrlFetchApp = G.urlFetchFiel(manejar);
    return sf;
  }

  // Texto como el de un export de reporte con una fila por oportunidad:
  // el caso real aparece 3 veces en bloques distintos de 40 (18 caracteres, con comillas y en 15),
  // más líneas vacías y el contacto que difiere en una mayúscula.
  function idsDeReporte() {
    const lineas = [];
    for (let i = 0; i < 100; i++) {
      lineas.push(idGenerico(i));
      if (i === 5) lineas.push(REAL);
      if (i === 55) lineas.push('"' + REAL + '"');
      if (i === 90) lineas.push('  ' + REAL.slice(0, 15));
      if (i === 20) lineas.push('', '   ');
    }
    lineas.push(REAL_OTRA_MAYUS);
    return lineas.join('\r\n');
  }

  const api = { to18, crearSalesforceFalso, DESCRIBE, idsDeReporte, REAL, REAL_OTRA_MAYUS, CON_OPP_ABIERTA, USUARIOS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.SFFalso = api;
})(typeof window !== 'undefined' ? window : globalThis);
