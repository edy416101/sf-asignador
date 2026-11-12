# Pruebas de Cat-alyst (simuladas, sin tocar nada real)

Todo cambio se prueba aquí **antes** de subirlo. Las pruebas corren el código real de Cat-alyst
(`index.html` y `backend/Code.gs`) contra un **Salesforce falso en memoria**: no hay SID, no hay
llamadas a Salesforce, a Apps Script ni a Google. Solo necesitas Node (sin `npm install`).

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

Para comparar contra otra versión (por ejemplo, la de `main` antes de un arreglo):

```bash
git show origin/main:index.html > /tmp/index-main.html
node tests/run.js /tmp/index-main.html
```

## 2. Simulador en el navegador

```bash
node tests/sim/serve.js
```

Abre http://localhost:8733 y presiona **▶ Correr simulación** (abajo a la derecha). Entra sin
login de Google, hace una Asignación con IDs repetidos y un Data Import en el que Salesforce
"rechaza" dos filas (una con un error de dos renglones), y muestra un panel con lo que pasó.

- Toda llamada al backend la responde `tests/sim/sim-mock.js`: la Asignación corre el
  `Code.gs` real con el Salesforce falso; el import usa un Bulk API falso.
- Cualquier otra petición de red se **bloquea** y aparece en el panel.
- También acepta otra versión: `node tests/sim/serve.js ruta/a/index.html`.

## Archivos

| Archivo | Qué es |
|---|---|
| `run.js` | Las pruebas de Node |
| `lib/sf-falso.js` | Salesforce falso y datos de prueba (lo usan Node y el navegador) |
| `lib/cargar.js` | Carga funciones de `index.html` y corre `Code.gs` aislado |
| `sim/serve.js` | Servidor local del simulador |
| `sim/sim-mock.js` | Backend falso, bloqueo de red y botón de simulación |

Al agregar un arreglo, agrega su caso en `run.js` (y en `SIM.correr` si se ve en la UI):
primero debe fallar con la versión vieja y pasar con la nueva.
