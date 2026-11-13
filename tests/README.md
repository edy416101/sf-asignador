# Pruebas de Cat-alyst (simuladas, sin tocar nada real)

Todo cambio se prueba aquí **antes** de subirlo. Las pruebas corren el código real de Cat-alyst
(`index.html` y `backend/Code.gs`) contra un **Salesforce falso en memoria** y una **Bulk API
falsa**: no hay SID, no hay llamadas a Salesforce, a Apps Script ni a Google. Solo necesitas
Node (sin `npm install`) y Chrome o Edge.

## Un solo comando

```bash
node tests/todo.js
```

Corre las pruebas de Node y el simulador del navegador, y termina en `✓ Todo en verde` o con las
fallas. Se corre antes de cada PR, y `scripts/publicar-backend.sh` lo corre antes de publicar.

**Candado de red.** Las pruebas no pueden salir a internet, ni aunque el código lo intente:

- En Node, `tests/lib/candado-red.js` corta `http`, `https`, sockets y `fetch` fuera de
  localhost.
- En el navegador, `tests/sim/headless.js` corta desde Chrome toda petición que no sea a
  localhost, SheetJS o las fuentes. Eso incluye Salesforce, Apps Script, Google y Drive.
- En cada corrida se manda una petición de prueba a un host `.invalid`, que no existe, para
  comprobar que el candado está activo. Si algo se escapa, la corrida falla.

## 1. Pruebas automáticas (Node)

```bash
node tests/run.js
```

Imprime ✓/✗ por prueba y termina con código 1 si algo falla. Cubre:

- **IDs de Contactos:** deduplicación (mismo ID repetido, 15 vs 18 caracteres, mayúsculas,
  líneas vacías, comillas, orden, IDs inválidos).
- **Resultado del import:** las filas con error del CSV de Bulk API 2.0 respetan sus columnas
  aunque el error o un dato traigan saltos de línea, comas o comillas.
- **Asignación de punta a punta:** `procesarAsignacion()` de `Code.gs` con el Salesforce falso
  (el query va en bloques de 40, igual que en producción): sin `Contact__c` repetidos, la
  exclusión por opp abierta sigue funcionando, todas las filas con el OwnerId de un rep.
- **v17 · Frontend** (`frontend-v17.js`): parser CSV/TSV con comillas, saltos de línea y tabs;
  headers que no se confunden con datos; validación de filas; candado contra doble clic;
  resultados por API Name; merge del retry; escapes y descargas CSV.
- **v17 · Backend** (`backend-v17.js`): import partido en jobs parejos de 50 (ordenados por OwnerId), Filas por job y Jobs a la vez, idempotencia por
  `clientRequestId`, estado sumado, CSV unidos, reintento por `UNABLE_TO_LOCK_ROW`, fallos al
  iniciar (abort), `resultsError`, y seguridad de `doPost` (token falso con la misma cola,
  `action` con `=`, `instanceUrl` ajeno, `operation` fuera de lista, token basura, baja de usuario).
- **v18 · Falsos fieles** (`v18-falsos.js`): los falsos se portan como los reales donde se
  pueden perder datos o duplicar Leads (ver la tabla de abajo), y pruebas de lo que no tenía
  ninguna: `doGet`, rate limit por usuario, cada rama del login de Google (`validarIdToken`),
  exportes a Sheets (nuevo, adjunto, desde CSV y desde Excel) y el panel admin (altas, bajas,
  métricas y huérfanos). Todo entra por `doPost` real.
- **v18 · Sin Leads duplicados** (`v18-duplicados.js`): cada camino por el que v17 podía crear
  el mismo Lead dos veces (resultado de más de 100 KB, respuesta del cierre perdida, cierre que
  responde 500 pero sí cerró, reintento por bloqueo lanzado dos veces o no encontrado al
  recuperar parte del lote, lote con jobs abortados) y una **prueba de estrés** con 320
  escenarios aleatorios (filas, reps, caídas de red antes y después de que Salesforce procese,
  bloqueos, rechazos, Retry y Recuperar). Invariante: cada `Contact__c` se crea una sola vez y
  lo que el cliente cree fallido no existe en Salesforce. `ESTRES=2000 node tests/run.js` corre
  más escenarios. También las funciones del navegador: `clientRequestId` estable, lista de
  pendientes y filas "En proceso".
- **v18 · Datos al campo correcto** (`v18-campos.js` y el paso 4c del simulador): validación
  antes de mandar (picklists restringidos contra el describe, booleanos, números y
  obligatorios de negocio), carga manual (sin encabezados, `import_result.csv`, `Contact__c`
  repetidos), columnas del resultado recuperado, y en la página: campos custom que entran y
  salen de las filas sin correr valores, Field Mapping por nombre, valores manuales aplicados,
  bloqueo durante un import, país PE/AR y Recuperar que pregunta antes de reemplazar.
- **v17 · Tiempo simulado** (`tiempo-v17.js`): la Bulk API falsa tarda como Salesforce
  (~1.15 s por Lead, transacciones de 200 en serie dentro de cada job, jobs distintos a la vez).
  El reloj es simulado, así que la prueba tarda milisegundos. Se calibró con el job real de 500
  Leads del 12-nov-2026, que tardó 10.5 min: un solo job da 9.8 min. Con v17.2 (10 jobs de 50) da
  1.0 min, con 1, 2 o 10 reps. Con los valores de Inspector por defecto (200 y 6) da 3.3 min.
  No mide los bloqueos entre jobs ni si Salesforce corre todos los jobs a la vez.

Para comparar contra otra versión (por ejemplo, la de `main` antes de un arreglo):

```bash
git show origin/main:index.html > /tmp/index-main.html
git show origin/main:backend/Code.gs > /tmp/Code-main.gs
node tests/run.js /tmp/index-main.html                 # frontend viejo
CODE_GS=/tmp/Code-main.gs node tests/run.js            # backend viejo
```

## 2. Simulador en el navegador

```bash
node tests/sim/serve.js
```

Abre http://localhost:8733 y presiona **▶ Correr simulación** (abajo a la derecha). Entra sin
login de Google y recorre: Asignación con IDs repetidos → Data Import con doble clic (se parte
en varios jobs; Salesforce rechaza dos filas, una con un error de dos renglones, y bloquea otra
que se reintenta sola) → Retry de las fallidas → Recuperar por Lote. Muestra un panel con lo
que pasó.

- Toda llamada al backend entra por `doPost` del `Code.gs` real (token, whitelist, rate limit,
  auditoría y ruteo), con los mismos falsos de Salesforce, Bulk API y Google que usa Node.
- Cualquier otra petición de red (`fetch`) se **bloquea** y aparece en el panel.
- También acepta otra versión: `node tests/sim/serve.js ruta/a/index.html`.
- Sin abrir el navegador: `node tests/sim/headless.js` corre lo mismo en Chrome headless.

## Archivos

| Archivo | Qué es |
|---|---|
| `todo.js` | El comando único: Node + simulador, con candado de red |
| `run.js` | Las pruebas de Node (incluye `frontend-v17.js`, `backend-v17.js`, `v18-*.js` y `tiempo-v17.js`) |
| `lib/candado-red.js` | Corta cualquier salida a internet desde Node |
| `sim/headless.js` | Corre el simulador en Chrome headless y corta la red desde Chrome |
| `lib/google-falso.js` | Google falso (Node y navegador): CacheService con TTL y límites de 100 KB / 250 caracteres, LockService que puede estar ocupado, Sheets y Drive con hojas por nombre, carpetas y permisos, tokeninfo, y `urlFetchFiel` (truena con URLs de más de 2048 caracteres y con 4xx/5xx sin `muteHttpExceptions`) |
| `lib/sf-falso.js` | Salesforce falso: queries de la asignación, `describe` de Lead y Contact con tipos y picklists, 401 y `done:false` a pedido |
| `lib/bulk-falso.js` | Bulk API 2.0 falsa: IDs de 18, rechazos, bloqueos (también envueltos en otro error), jobs `Failed` con `errorMessage` y `unprocessedrecords`, cerrar dos veces → 400, abortar no deshace, caídas de red antes o después de que Salesforce procese, upsert; con `reloj`, tarda como Salesforce |
| `lib/cargar.js` | Carga funciones de `index.html` y corre `Code.gs` aislado con los servicios de Google falsos |
| `lib/config-prueba.gs` | Correos e IDs falsos que reemplazan a `backend/config.local.gs` (que no está en git) |
| `sim/serve.js` | Servidor local del simulador |
| `sim/sim-mock.js` | Backend simulado, bloqueo de red y botón de simulación |

Al agregar un arreglo, agrega su caso en `run.js` (y en `SIM.correr` si se ve en la UI):
primero debe fallar con la versión vieja y pasar con la nueva.
