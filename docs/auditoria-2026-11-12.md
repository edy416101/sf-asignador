# Auditoría de sf-asignador (12-nov-2026)

Revisión completa de `index.html` y `backend/Code.gs` (v16.4). Base para la v17.

## 1. Por qué un insert de 500 Leads tardó 10.5 min

Caso: job `750Tt00000mJwvvIAC`, 12-nov-2026. Medido con el `CreatedDate` de los 500 Leads.

| Bloque | Inicio (UTC) | Registros | Duración aprox. |
|---|---|---|---|
| 1 | 21:24:40 | 200 | 5 min |
| 2 | 21:29:41 | 200 | 3 min |
| 3 | 21:32:46 | 100 | 1.5 min |

- No hubo cola. El primer bloque empezó 4 s después de crear el job.
- Los bloques corrieron uno tras otro. Bulk API 2.0 junta hasta 10,000 registros en un lote
  interno y lo procesa en transacciones de 200, en serie. Un job de 500 nunca corre en paralelo.
- Cada Lead cuesta cerca de 1 s en Salesforce. Al crear un Lead corren 6 triggers (Plauti
  `leadassist`, Rollup Helper `rh2`, Talkdesk, `LeadTriggerHandler`, MME) y 6 flows de create
  (Cadence, Plauti Info Parse, Async Messaging y otros).
- La tool pone cerca de 1 de los 10.5 min: 7 s de describe, 8 s para crear el job y 40 s entre
  el sondeo de 10 s y la descarga final.

**Conclusión.** La mejora grande es partir la carga en varios jobs que corran en paralelo. Es la
única forma de paralelizar con Bulk API 2.0. La causa de fondo, 1 s por Lead, está en la
automatización de Salesforce y se pide a Global SF.

**Estimado v17.** 500 filas en 5 jobs de 100. Un bloque de 100 tardó 1.5 min, así que el total
debería quedar entre 2 y 3 min. Falta confirmarlo con una carga real.

## 2. Hallazgos

### Seguridad (P0)

| Hallazgo | Dónde | Riesgo |
|---|---|---|
| La llave del caché de tokens son los últimos 32 caracteres del token. Quien conozca esa cola entra sin verificar. | `validarIdToken` | Acceso sin login |
| `action` se escribe tal cual en el Sheet de auditoría y el web app es `ANYONE_ANONYMOUS`. Cualquiera puede inyectar fórmulas. | `doPost`, `registrarAuditoria` | Fórmulas en el Sheet |
| Un token basura igual dispara un fetch a Google y una fila de auditoría. | `validarIdToken` | Ruido y abuso |
| `instanceUrl`, `object` y `operation` no se validan. El `sid` se puede mandar a cualquier host. | describe, import, jobs | Robo del SID |
| `exportSheet` en modo attached abre cualquier Sheet que vea la cuenta del script, incluido el de auditoría. | `exportarResultadoASheet` | Escritura en archivos ajenos |
| Al dar de baja a un usuario, su token sigue en caché hasta 5 min. | `adminEliminarUsuario` | Acceso tras la baja |
| `esc()` no escapa `'`. `log()` e `ilog()` meten HTML sin escapar. | `index.html` | XSS |
| El SID se queda en el campo al cerrar sesión y el navegador lo puede autocompletar. | `logout`, `#sid` | SID expuesto |
| SheetJS 0.18.5 tiene vulnerabilidades conocidas y se carga sin SRI. | `<head>` | Librería vulnerable |

### Integridad de datos (P0)

| Hallazgo | Dónde |
|---|---|
| `actualizarFuenteImport()` reactiva el botón de import a mitad de un import. Un segundo clic crea Leads duplicados. | `actualizarFuenteImport` |
| No hay idempotencia: si la respuesta de `importStart` se pierde, reintentar crea otro job. | `iniciarImportBulk` |
| `parseTsv` y `parseCsvFullText` parten la fila si una celda trae salto de línea. Hay 4 parsers distintos. | carga manual |
| La vista previa agrega campos custom al estado global, y basta con 3 nombres "válidos" para tratar la primera fila como headers. Valores como `Mexico` o `FALSE` terminan como campos. | `actualizarPreviewCarga` |
| No se validan las filas antes de enviarlas (obligatorios, `OwnerId`, email, fechas). | `ejecutarImport` |
| Si falla la descarga de resultados, se reporta un éxito vacío. No se bajan los `unprocessedrecords`. | `recuperarResultadoJob` |
| `recuperarJob` siempre se audita como `success`. Si falla la subida, el job queda abierto en Salesforce. | `doPost`, `iniciarImportBulk` |
| El sondeo saca un `alert` por cada rate limit. Si la sesión expira, se cierra la sesión y se pierde el contexto del job. Cuenta intentos, no tiempo. | `backendFetch`, `sondearJob` |
| El job pendiente se borra de `localStorage` antes de recuperarlo, y la llave es la misma para todos los usuarios del navegador. | `recuperarJobPendiente` |

### Velocidad (P1)

| Hallazgo | Dónde |
|---|---|
| Todo el import va en un solo job: Salesforce lo procesa en serie. | `iniciarImportBulk` |
| Crear, subir y cerrar son 3 llamadas en serie. | `iniciarImportBulk` |
| Sondeo fijo de 10 s. | `sondearJob` |
| El describe de Lead se pide de nuevo en cada import después de "Limpiar". | `limpiarImport` |
| `ejecutarImportBulk` y la ruta `"import"` son código muerto con la misma construcción de CSV duplicada. | `Code.gs` |

### Resto (P2)

- `procesarAsignacion`: no revisa el código HTTP de cada bloque, así que un fallo de Contact se
  traga sin aviso. No valida IDs ni `dias`. Hace 1 query por cada 40 IDs, en serie.
- No deduplica reps ni filtra `User.IsActive`.
- El 401 de Salesforce solo se maneja en `jobStatus`.
- El rate limit no cubre `describe`, `adminData` ni acciones desconocidas, y no usa `LockService`.
  El alta y la baja de usuarios tampoco.
- Exportes: el Summary hace decenas de `setValue`. El export desde CSV no neutraliza fórmulas,
  tampoco las descargas CSV. Un error a la mitad deja archivos huérfanos en Drive.
- `SF_API_VERSION` es v57.0. `appsscript.json` no declara `oauthScopes`.
- Retry: el merge usa `Contact__c` como llave y se rompe si esa columna se omite o se repite.
  Se puede lanzar un segundo retry encima del primero. No maneja `stillProcessing`.
- Las tablas pintan todas las filas.
- El JWT se decodifica sin UTF-8. Los CSV en ANSI (Excel en Windows) se leen mal.
- `syncMapCheck` y varias copias de `log`, `ilog` y del escape CSV sobran.

## 3. Fuera de la tool

Pedir a Global SF (con Alejandro) que revise la automatización del insert de Lead. Evidencia: el
job `750Tt00000mJwvvIAC` y los `apexProcessingTime` que la v17 muestra en el log. El texto se
redacta aparte.
