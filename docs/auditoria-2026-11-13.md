# Auditoría de sf-asignador (13-nov-2026)

Revisión completa de `index.html` y `backend/Code.gs` (v17.2). Hubo 3 revisiones: backend,
frontend, y contrato y pruebas. Todo se arregló en 6 PRs (#19 a #24). El backend quedó en
v18.4. Todo se probó con Salesforce, Bulk API y Google falsos. No se tocó nada real.

## 1. Lo más grave: Leads duplicados o valores en el campo equivocado

| Hallazgo | Qué podía pasar | Arreglo | PR |
|---|---|---|---|
| `iniciarImportBulk` guardaba en caché el resultado completo | Con más de 100 KB, `cache.put` tronaba después de crear los jobs, se borraba la marca de idempotencia y un reintento duplicaba los Leads | Se guarda una versión chica (índices de las filas no enviadas). Después de intentar cerrar un job, la marca ya no se borra | #20 |
| Ronda 3: si el cierre fallaba o tronaba, los jobs se daban por caídos | Jobs que sí corrieron salían como "no enviados" y un Retry los duplicaba | Se pregunta el estado a Salesforce. Solo es caído un job que sigue `Open`. Un job `Open` de más de 10 min se aborta al consultarlo | #20 |
| `buscarReintentoLock` exigía el mismo set exacto de jobIds | Recuperar parte del lote no encontraba el reintento por bloqueo: esas filas salían fallidas y un Retry las duplicaba | Una llave por cada job original; en la auditoría basta con uno. IDs de 15 y 18 caracteres son el mismo | #20 |
| `lanzarReintentoLock` sin candado | Dos peticiones a la vez lanzaban dos reintentos | `LockService` y marca "creando" | #20 |
| `separarFilasLock` solo veía el bloqueo al inicio del error | Un bloqueo envuelto en el error de un trigger no se reintentaba | Se busca en todo el texto | #20 |
| El botón de import y el Retry se reactivaban con un lote pendiente | Un segundo clic mandaba otra vez las mismas filas | Mismo `clientRequestId` mientras las filas no cambien. Lista de lotes pendientes. Las filas sin resultado quedan "En proceso" y no se reintentan ni se vuelven a importar | #20 |
| Recuperar un lote leía cualquier fila de la auditoría | Podía traer el job abortado o el de reintento como si fuera del import | Solo filas del import, con `vivos=` | #20 |
| `quitarCustomField` quitaba el campo del encabezado pero no de las filas | Los valores se corrían a la columna de al lado | La columna sale de las filas. Un custom nuevo entra a las filas | #21 |
| `switchTab('import')` no rehacía el Field Mapping | Se importaba con un mapeo viejo, por posición | Mapeo por nombre de columna. Se rehace al entrar y al cambiar columnas. El import se bloquea si no cuadra | #21 |
| La query de Users metía cada rep dos veces en la URL | Con unos 24 reps pasaba de 2 kB y la asignación tronaba | Bloques de 10 reps | #23 |

**Prueba de estrés.** 320 escenarios aleatorios en cada corrida (1,000 en la corrida de cierre:
120,418 filas y 5,797 caídas de red). Mezclan filas, reps, caídas de red antes y después de que
Salesforce procese, bloqueos, rechazos, Retry y Recuperar. Resultado: ningún `Contact__c` se
creó dos veces, y ninguna fila que el cliente marcó como fallida existía en Salesforce. Con el
backend de v17.2 la misma prueba encuentra duplicados.

## 2. Lo demás que se arregló

**Datos al campo correcto (#21).** Valores manuales nuevos se aplican a las filas que ya existen.
Durante un import no se puede cambiar asignación, país ni campos. Antes de mandar se revisan los
picklists contra el describe (restringido bloquea, no restringido avisa), booleanos, números y
obligatorios de negocio. Países PE (`Peru`) y AR (`Argentina`). Recuperar pregunta antes de
reemplazar la tabla y conserva las columnas custom. Carga manual: sin encabezados pide confirmar
el orden, un `import_result.csv` carga solo las filas `Failed`, y se avisa de `Contact__c` repetidos.

**Sesión (#22).** Al vencer el token de Google, un recuadro pide entrar otra vez con la misma
cuenta y solo cambia el token. La sesión nunca se cierra sola si hay filas o resultados. Si Google
no responde (5xx, 429 o red), no es un rechazo. El backend no manda a Google tokens sin `aud` e
`iss` de Google, y tiene un tope de rechazos por minuto que no llena la auditoría. Aviso al cerrar
la pestaña con import en curso o resultados sin guardar. Salir limpia todo.

**Asignación, exportes y backend (#23).** OwnerId por Username y después por Email; un Email con 2
usuarios activos no se asigna. Los IDs por query se calculan con el largo del SELECT. `jobState`
correcto mientras no terminan todos los jobs, y lo reintentado no cuenta doble. Al exportar, el
usuario debe ser editor de la carpeta que pide; un doble clic no crea dos Sheets y la pestaña se
abre sin bloqueo de popups. La auditoría se escribe por nombre de hoja (nunca en `Usuarios`).
`sanitizarPayload` nunca deja filas en el log. Tipos de entrada validados. Whitelist y admins en
minúsculas.

**Detalles de uso (#24).** Esc y foco en los modales, pestañas con flechas, toasts con
`aria-live`. Textos de "Lote o Job ID" y "0 (solo hoy)". Copiar con saltos de línea.

**Pruebas (#19).** Los falsos se portan como los reales donde se pueden perder datos: CacheService
con TTL y límites, LockService ocupado, UrlFetchApp que truena con URLs largas, Bulk API con jobs
`Failed`, cierres repetidos y caídas de red, y Salesforce con describe y 401. El simulador entra
por `doPost` real. Hoy hay 210 pruebas de Node y 46 checks del simulador.

## 3. Versiones publicadas del backend

| Versión | PR | Qué trae |
|---|---|---|
| 18.0 | #20 | Sin Leads duplicados |
| 18.1 | #21 | `restrictedPicklist` en el describe |
| 18.2 | #22 | Sesión de Google más firme |
| 18.3 | #23 | Asignación, exportes, auditoría y entradas |
| 18.4 | #24 | Texto de "Días" en el Summary |

Cada una se publicó con `scripts/publicar-backend.sh` y la URL respondió la versión nueva.

## 4. Fuera de alcance

- **Rotar la auditoría por mes.** Hoy se leen las últimas 5,000 filas. Para decidir cómo rotar
  hace falta ver cuántas filas crecen por mes en el Sheet real.
- **Fijar `INSTANCE_URL_REGEX` al dominio de la org.** Hoy acepta cualquier `*.my.salesforce.com`.
  Para fijarlo hace falta confirmar el dominio exacto de producción y de los sandboxes.
- **Límite diario de batches de Bulk API.** Con 50 filas por job, un import de 500 filas usa unos
  10 batches. El límite de la org es de 15,000 batches cada 24 horas, así que no es un riesgo hoy.
  Si se usan jobs más chicos o muchos imports al día, conviene revisarlo.

## 5. Qué falta confirmar con datos reales

- Que un job `Open` de más de 10 min se pueda abortar sin problema en la org (en las pruebas sí).
- Que `restrictedPicklist` venga en el describe real para `Country__c` y `Status`.
- El tiempo de un import real con la v18 (no cambia la velocidad de la v17.2).
