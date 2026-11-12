// Salesforce FALSO en memoria. Lo usan las pruebas de Node y el simulador del navegador.
// Nunca hace llamadas de red: responde las mismas consultas SOQL que manda Code.gs.
(function (raiz) {

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

  function crearSalesforceFalso() {
    const contactos = new Map();   // llave: primeros 15 caracteres, como Salesforce
    const alta = (id15, nombre) => contactos.set(id15, {
      Id: to18(id15), LastName: nombre, Email: nombre.toLowerCase() + '@test.local',
      Account: { Name: 'Clinica ' + nombre }, LastSourceAt__c: null
    });
    for (let i = 0; i < 100; i++) alta(idGenerico(i), 'Doc' + i);
    alta(REAL.slice(0, 15), 'CarlosGuerrero');
    alta(REAL_OTRA_MAYUS.slice(0, 15), 'OtraPersona');

    const sf = { llamadas: 0 };
    sf.UrlFetchApp = {
      fetch(url) {
        sf.llamadas++;
        const soql = decodeURIComponent(String(url).split('?q=')[1] || '');
        let records = [];
        if (/FROM User/.test(soql)) {
          const emails = [...soql.matchAll(/'([^']+)'/g)].map(m => m[1]);
          records = [...new Set(emails)].filter(e => USUARIOS[e]).map(e => ({ Id: USUARIOS[e], Email: e, Username: e }));
        } else if (/FROM Contact WHERE Id IN \(/.test(soql)) {
          const ids = [...soql.match(/FROM Contact WHERE Id IN \(([^)]*)\)/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
          // Igual que Salesforce: cada registro sale UNA vez por query, aunque el ID venga repetido o en 15/18
          const vistos = new Map();
          ids.forEach(id => {
            const k = id.slice(0, 15);
            if (contactos.has(k) && k !== CON_OPP_ABIERTA) vistos.set(k, contactos.get(k));
          });
          records = [...vistos.values()];
        }
        return { getContentText: () => JSON.stringify({ records }), getResponseCode: () => 200 };
      }
    };
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

  const api = { to18, crearSalesforceFalso, idsDeReporte, REAL, REAL_OTRA_MAYUS, CON_OPP_ABIERTA, USUARIOS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.SFFalso = api;
})(typeof window !== 'undefined' ? window : globalThis);
