#!/usr/bin/env bash
# Publica backend/ en Apps Script como versión nueva del MISMO deployment (la URL no cambia).
# Corre solo en la PC con el login de clasp (~/.clasprc.json). Nada de esto pasa por GitHub.
#
# Uso: bash scripts/publicar-backend.sh
set -euo pipefail

DEPLOY_ID="AKfycbwdGabBI1MBp-YIOWnB2rXF24888c8Kt8dsQ530IW4ZjcNIszYsyNUxbIvkzGMwL24OuQ"
URL="https://script.google.com/macros/s/$DEPLOY_ID/exec"
CLASP="npx -y @google/clasp@2.4.2"

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"

# 1. Solo se publica lo que ya está en main de GitHub, sin cambios locales.
git fetch -q origin
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "✗ Cambia a main antes de publicar."; exit 1; }
[ -z "$(git status --porcelain -- backend)" ] || { echo "✗ Hay cambios sin commit en backend/."; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "✗ main local no es igual a origin/main (haz git pull)."; exit 1; }

# 2. Archivos locales que nunca van a GitHub.
[ -f backend/.clasp.json ] || { echo "✗ Falta backend/.clasp.json (scriptId del proyecto Cat-alyst)."; exit 1; }
[ -f backend/config.local.gs ] || { echo "✗ Falta backend/config.local.gs (correos y IDs). Copia docs/config.ejemplo.gs."; exit 1; }

# 3. Pruebas simuladas.
node tests/run.js > /dev/null || { echo "✗ Fallan las pruebas: node tests/run.js"; exit 1; }

# 4. Subir y publicar.
VERSION="$(sed -n 's/^var VERSION_BACKEND *= *"\([^"]*\)".*/\1/p' backend/Code.gs)"
COMMIT="$(git rev-parse --short HEAD)"
# Se sube desde una copia sin BOM: clasp no lee un appsscript.json que empieza con BOM
# ("Input params not Valid JSON string").
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp backend/.clasp.json backend/Code.gs backend/appsscript.json backend/config.local.gs "$TMP/"
for f in "$TMP"/Code.gs "$TMP"/appsscript.json "$TMP"/config.local.gs; do sed -i '1s/^\xEF\xBB\xBF//' "$f"; done
(cd "$TMP" && $CLASP push -f && $CLASP deploy -i "$DEPLOY_ID" -d "v$VERSION ($COMMIT)")

# 5. Verificar que la URL ya responde con la versión nueva.
RESP="$(curl -sL "$URL")"
echo "$RESP"
echo "$RESP" | grep -q "\"version\":\"$VERSION\"" && echo "✓ Backend v$VERSION publicado." || { echo "✗ La URL no responde v$VERSION."; exit 1; }
