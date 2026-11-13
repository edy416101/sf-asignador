// v18 · Sesión y robustez del backend: una falla temporal de Google no es authError, un token
// que no es de Google para esta app ni se manda a Google, y hay un tope global de rechazos por
// minuto que no llena la auditoría. Todo por doPost real, sin red.
const assert = require('assert');
const { cargarBackend, serviciosGoogleFalsos } = require('./lib/cargar');
const { urlFetchFiel } = require('./lib/google-falso');
const SF = require('./lib/sf-falso');

const INSTANCIA = 'https://docplanner.my.salesforce.com';
const USUARIO = 'usuario.prueba@docplanner.com';
const b64 = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let n = 0;
const jwt = c => b64('{"alg":"RS256"}') + '.' + b64(JSON.stringify(c)) + '.firmaSesion' + (++n) + 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

function montar(opcionesGoogle = {}) {
  const g = serviciosGoogleFalsos(opcionesGoogle);
  const s = SF.crearSalesforceFalso();
  let llamadasGoogle = 0;
  const gf = urlFetchFiel((u, o) => { llamadasGoogle++; return g.google(u, o); });
  const destino = url => (/googleapis\.com/.test(url) ? gf : s.UrlFetchApp);
  const ctx = cargarBackend({ fetch: (u, o) => destino(u).fetch(u, o), fetchAll: r => r.map(x => destino(x.url).fetch(x.url, x)) },
    process.env.CODE_GS || null, g.globales);
  const claims = extra => Object.assign({ email: USUARIO, hd: 'docplanner.com', exp: Math.floor(Date.now() / 1000) + 3000,
    aud: ctx.GOOGLE_CLIENT_ID, iss: 'https://accounts.google.com' }, extra || {});
  const tokenBueno = () => {
    const c = claims(), t = jwt(c);
    g.registrarToken(t, { aud: ctx.GOOGLE_CLIENT_ID, hd: 'docplanner.com', email_verified: 'true', exp: String(c.exp), email: USUARIO });
    return t;
  };
  const post = p => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(p) } }).getContent());
  return { g, ctx, claims, tokenBueno, post, llamadas: () => llamadasGoogle };
}
const describe = (m, t) => m.post({ idToken: t, action: 'describe', sid: 'SID', instanceUrl: INSTANCIA, object: 'Lead' });

module.exports = function (prueba, setGrupo) {
  setGrupo('v18 · Sesión: Google caído no saca al usuario');
  [[500, 'Google responde 500'], [503, 'Google responde 503'], [429, 'Google responde 429 (saturado)'], ['excepcion', 'falla la red hacia Google']].forEach(([falla, nombre]) => {
    prueba(nombre + ' → authTemporal (no authError) y sin fila de auditoría', () => {
      const m = montar();
      const t = m.tokenBueno();
      m.g.opciones.tokeninfoFalla = falla;
      const r = describe(m, t);
      assert.strictEqual(r.authError, undefined, JSON.stringify(r));
      assert.strictEqual(r.authTemporal, true, JSON.stringify(r));
      assert.strictEqual(m.g.auditoria.length, 0);
      m.g.opciones.tokeninfoFalla = null;
      assert.ok(describe(m, t).fields, 'al volver Google, el mismo token entra');
    });
  });

  setGrupo('v18 · Sesión: tokens ajenos y tope de rechazos');
  prueba('token sin aud de esta app o sin iss de Google → rechazado sin preguntar a Google y sin auditar', () => {
    const m = montar();
    [m.claims({ aud: 'otra-app.apps.googleusercontent.com' }), m.claims({ iss: 'https://evil.example.com' }), m.claims({ aud: undefined, iss: undefined })].forEach(c => {
      const r = describe(m, jwt(c));
      assert.strictEqual(r.authError, true, JSON.stringify(r));
    });
    assert.strictEqual(m.llamadas(), 0);
    assert.strictEqual(m.g.auditoria.length, 0);
  });
  {
    const m = montar();
    const respuestas = [];
    for (let i = 0; i < 70; i++) respuestas.push(describe(m, jwt(m.claims())));   // bien formados, pero Google no los conoce
    const filasAuditoria = m.g.auditoria.filter(f => f[3] === 'auth_rechazado').length;
    prueba('70 tokens rechazados en un minuto: solo los primeros 20 llegan a la auditoría', () => {
      assert.ok(respuestas.slice(0, 60).every(r => r.authError === true));
      assert.strictEqual(filasAuditoria, 20);
    });
    prueba('…y pasado el tope (60) ya no se pregunta a Google', () => {
      assert.strictEqual(m.llamadas(), 60);
      assert.ok(respuestas.slice(60).every(r => r.authTemporal === true), JSON.stringify(respuestas[65]));
    });
    prueba('…pero un usuario con su token ya validado (en caché) sigue entrando', () => {
      const m2 = montar();
      const t = m2.tokenBueno();
      assert.ok(describe(m2, t).fields);
      for (let i = 0; i < 61; i++) describe(m2, jwt(m2.claims()));
      assert.ok(describe(m2, t).fields, 'el token cacheado debía seguir sirviendo');
    });
    prueba('…y al minuto siguiente el contador empieza de cero', () => {
      const llave = [...m.g.cache.keys()].find(k => /^rech_/.test(k));
      assert.ok(llave, 'no hay contador de rechazos');
      m.g.cache.delete(llave);   // el minuto cambió (la llave lleva el minuto)
      const antes = m.llamadas();
      describe(m, jwt(m.claims()));
      assert.strictEqual(m.llamadas(), antes + 1);
    });
  }
};
