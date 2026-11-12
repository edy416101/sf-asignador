# Pruebas de Cat-alyst (simuladas, sin tocar nada real)

Todo cambio se prueba aquí **antes** de subirlo. Las pruebas corren el código real de Cat-alyst
(`index.html` y `backend/Code.gs`) contra un **Salesforce falso en memoria** y una **Bulk API
falsa**: no hay SID, no hay llamadas a Salesforce, a Apps Script ni a Google. Solo necesitas
Node (sin `npm install`).

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
- **v17 · Backend** (`backend-v17.js`): import partido en N jobs por OwnerId, idempotencia por
  `clientRequestId`, estado sumado, CSV unidos, reintento por `UNABLE_TO_LOCK_ROW`, fallos al
  iniciar (abort), `resultsError`, y seguridad de `doPost` (token falso con la misma cola,
  `action` con `=`, `instanceUrl` ajeno, `operation` fuera de lista, token basura, baja de usuario).

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

- Toda llamada al backend la responde `tests/sim/sim-mock.js` con el `Code.gs` real: la
  Asignación contra el Salesforce falso y el import contra la Bulk API falsa.
- Cualquier otra petición de red (`fetch`) se **bloquea** y aparece en el panel.
- También acepta otra versión: `node tests/sim/serve.js ruta/a/index.html`.

## Archivos

| Archivo | Qué es |
|---|---|
| `run.js` | Las pruebas de Node (incluye `frontend-v17.js` y `backend-v17.js`) |
| `lib/sf-falso.js` | Salesforce falso para la asignación (lo usan Node y el navegador) |
| `lib/bulk-falso.js` | Bulk API 2.0 falsa: jobs, rechazos, bloqueos, fallos y 401 a pedido |
| `lib/cargar.js` | Carga funciones de `index.html`, corre `Code.gs` aislado y servicios de Google falsos |
| `sim/serve.js` | Servidor local del simulador |
| `sim/sim-mock.js` | Backend simulado, bloqueo de red y botón de simulación |

Al agregar un arreglo, agrega su caso en `run.js` (y en `SIM.correr` si se ve en la UI):
primero debe fallar con la versión vieja y pasar con la nueva.
