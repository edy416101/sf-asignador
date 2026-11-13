// Prueba TODO Cat-alyst sin tocar nada real, con un solo comando:
//   1. Pruebas de Node (tests/run.js): Salesforce, Bulk API y Google falsos.
//   2. Simulador en Chrome headless (tests/sim/headless.js): la página real de punta a punta.
// Las dos partes tienen candado de red: si algo intenta salir a internet, la prueba falla.
//
// Uso:  node tests/todo.js
// Se corre antes de cada PR y antes de publicar el backend (scripts/publicar-backend.sh).
require('./lib/candado-red');
const { spawnSync } = require('child_process');
const path = require('path');
const { correr } = require('./sim/headless');

(async () => {
  console.log('1/2 · Pruebas de Node');
  const node = spawnSync(process.execPath, [path.join(__dirname, 'run.js')], { encoding: 'utf8' });
  const salidaNode = (node.stdout || '') + (node.stderr || '');
  const okNode = node.status === 0;
  const resumenNode = salidaNode.trim().split('\n').pop();
  if (!okNode) console.log(salidaNode.split('\n').filter(l => /✗|→|Error/.test(l)).join('\n'));
  console.log('    ' + (okNode ? '✓ ' : '✗ ') + resumenNode);

  console.log('2/2 · Simulador del navegador');
  let sim = await correr();
  if (sim.arranque) {   // Chrome no levantó a tiempo: un reintento. Un check que falla nunca se reintenta.
    console.log('    (reintento: ' + sim.salida.trim().split('\n').pop().trim() + ')');
    sim = await correr();
  }
  if (!sim.ok) console.log(sim.salida);
  console.log('    ' + (sim.ok ? '✓ ' : '✗ ') + sim.salida.trim().split('\n').pop().trim());

  const ok = okNode && sim.ok;
  console.log('\n' + (ok ? '✓ Todo en verde. Nada salió a sistemas reales.' : '✗ Hay fallas: no se publica.'));
  process.exit(ok ? 0 : 1);
})();
