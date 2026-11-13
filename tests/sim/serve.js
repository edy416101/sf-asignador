// Servidor local del simulador (sin dependencias). Sirve la página real con el backend falso inyectado.
//
// Uso:  node tests/sim/serve.js                       → http://localhost:8733 con el index.html del repo
//       node tests/sim/serve.js ruta/a/otro/index.html → la misma simulación con otra versión
// Variable PORT para cambiar el puerto.
const http = require('http');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const INDEX = path.resolve(process.argv[2] || path.join(RAIZ, 'index.html'));
const PORT = Number(process.env.PORT) || 8733;
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.gs': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const GSI = '<script src="https://accounts.google.com/gsi/client" async></script>';
const MOCK = '<script src="/tests/lib/google-falso.js"></script><script src="/tests/lib/sf-falso.js"></script><script src="/tests/lib/bulk-falso.js"></script><script src="/tests/sim/sim-mock.js"></script>';

http.createServer((req, res) => {
  const ruta = decodeURIComponent(req.url.split('?')[0]);
  if (ruta === '/' || ruta === '/index.html') {
    const html = fs.readFileSync(INDEX, 'utf8');
    if (!html.includes(GSI)) { res.writeHead(500); return res.end('No encontré el script de Google Sign-In en ' + INDEX); }
    res.writeHead(200, { 'Content-Type': TIPOS['.html'] });
    return res.end(html.replace(GSI, MOCK));   // sin login de Google: entra el simulador
  }
  const archivo = path.join(RAIZ, path.normalize(ruta));
  if (!archivo.startsWith(RAIZ) || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(archivo)] || 'application/octet-stream' });
  fs.createReadStream(archivo).pipe(res);
}).listen(PORT, () => console.log('Simulador de Cat-alyst en http://localhost:' + PORT + '  (' + path.relative(RAIZ, INDEX) + ')'));
