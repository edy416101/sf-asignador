# sf-asignador (Cat-alyst)

Tool de RevOps para asignar Contacts a reps y crear los Leads en Salesforce con Bulk API 2.0.
Owner: Edgar Martínez. Frontend en GitHub Pages (`index.html`), backend en Apps Script
(`backend/Code.gs`). Lo usan los equipos de MX, Perú y Argentina.

## Reglas

- **Solo pruebas simuladas.** Todo cambio se prueba con `node tests/run.js` (Salesforce falso en
  memoria) y, si se ve en la UI, con el simulador `node tests/sim/serve.js`. Cada arreglo lleva
  su caso en `tests/run.js`: falla con la versión vieja y pasa con la nueva.
- **Nada real sin confirmar con Edgar.** No usar un SID real, no correr imports, no llamar a
  Salesforce, Apps Script ni Google Sheets. Las cargas reales las hace Edgar.
- **Publicar el backend = `bash scripts/publicar-backend.sh`**, solo cuando Edgar lo pida y
  después de mergear a `main`. Usa clasp con el login de Edgar (`~/.clasprc.json`, solo en su
  PC) y publica una versión nueva del mismo deployment: la URL no cambia. Nunca se pega código
  a mano ni se crea otro deployment.
- **El repo es público.** Correos, admins, la carpeta de Drive y el Sheet de auditoría viven en
  `backend/config.local.gs` (en `.gitignore`; plantilla en `docs/config.ejemplo.gs`). Nunca
  subir ese archivo, `backend/.clasp.json` ni tokens a GitHub. Nada de GitHub Actions con
  credenciales.
- **Publicar = PR a `main` con descripción.** Pages publica `main`. Nunca push directo a `main`.
  Ramas por tema (`mejoras/…`, `fix/…`). El PR dice qué cambió, por qué y cómo se probó.
- **Claude mergea sus propios PRs** (`gh pr merge <n> --merge`) sin pedir permiso, en cuanto
  pasan `node tests/run.js` y el simulador si aplica. Lo autorizó Edgar el 12-nov-2026. Al
  terminar, avisarle qué se mergeó. Si el PR cambió el contrato entre backend y frontend,
  respetar el orden de "Backend y frontend van juntos".
- **Backend y frontend van juntos.** Si cambia el contrato de una acción (`importStart`,
  `jobStatus`, `recuperarJob`…), el backend sigue aceptando lo viejo hasta que el front nuevo
  esté publicado, o se despliegan en el orden correcto (primero backend, luego Pages).
- **Secretos:** el SID nunca se guarda, ni en `localStorage` ni en logs. `CAMPOS_SENSIBLES` en
  `Code.gs` lista lo que no se loguea.
- Versiones: subir el número en el encabezado de `Code.gs` y en `VERSION_BACKEND` (lo usan
  `doGet` y `health.version`; el script de publicación lo verifica en la URL).

## Contexto

- Diagnóstico de velocidad y hallazgos de la auditoría: `docs/auditoria-2026-11-12.md`.
- Pruebas: `tests/README.md`.
- La lentitud de fondo (~1 s por Lead) viene de la automatización de Salesforce al crear un Lead
  (triggers y flows). Eso se pide a Global SF; no se arregla en esta tool.
