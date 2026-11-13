// ══════════════════════════════════════════════════════════════════════════
//  SF ASIGNADOR · BACKEND — Google Apps Script  v17.1
//
//  Operaciones (lista cerrada en ACCIONES_PERMITIDAS):
//    · "asignacion" (default) → procesarAsignacion
//    · "describe"           → describirObjeto
//    · "importStart"        → iniciarImportBulk     ← v17: N jobs en paralelo, loteId
//    · "jobStatus"          → consultarEstadoJob    ← v17: acepta jobIds[]
//    · "recuperarJob"       → recuperarResultadoJob ← v17: jobIds[], loteId o jobId
//    · "exportSheet"        → exportarResultadoASheet
//    · "exportSheetFromFile"→ exportarSheetDesdeArchivo (CSV/Excel local)
//    · "adminData" / "adminAddUser" / "adminRemoveUser" → panel admin
//
//  v17.1: correos, admins, carpeta y Sheet de auditoría salen de este archivo
//    y viven en backend/config.local.gs (fuera de git). Se publica con
//    scripts/publicar-backend.sh (clasp), sin pegar código a mano.
//
//  CAMBIO CLAVE v17.0 — la carga se parte en varios jobs:
//    Bulk API 2.0 procesa un job en transacciones de 200, una tras otra, y
//    cada Lead cuesta ~1 s por la automatización de Salesforce. Un job de 500
//    tardó 10.5 min. Ahora se crean hasta MAX_JOBS_PARALELO jobs de ~FILAS_POR_JOB
//    filas, agrupadas por OwnerId, y Salesforce los corre a la vez. Crear, subir
//    y cerrar van en 3 rondas de UrlFetchApp.fetchAll.
//    Además: caché de tokens por SHA-256, auditoría neutralizada, listas
//    permitidas para instanceUrl/object/operation, idempotencia por
//    clientRequestId y reintento automático de filas con UNABLE_TO_LOCK_ROW.
//
//  CAMBIO CLAVE v14.0 — el backend ya no se queda esperando:
//    Antes, "import" hacía crear+subir+cerrar+ESPERAR+descargar en una sola
//    petición. Ese "esperar" era Utilities.sleep() en bucle (hasta 5.5 min) y
//    chocaba con el límite de 6 min de Apps Script: con 790 registros la
//    ejecución moría y se perdía el jobId, aunque Salesforce sí terminaba.
//    Ahora la espera vive en el frontend, repartida en consultas de ~1s.
//    Se sigue mandando UN SOLO job de Bulk API 2.0: se parte la espera, no los datos.
//
//  SEGURIDAD v11.0:
//    · Todas las operaciones validan el id_token de Google del frontend
//    · Solo se permiten emails @docplanner.com (dominio hardcodeado)
//    · Cada request se registra en la hoja de auditoría (opcional)
//    · Cache de tokens verificados (5 min) para evitar llamadas repetidas
//
//  FUNCIONALIDAD v11.0:
//    · Carpeta de Drive por defecto (v17.1: en config.local.gs)
//    · Nueva operación exportSheetFromFile: recibe un CSV/XLSX en base64,
//      lo sube a Drive, lo convierte a Sheet y le añade las 3 hojas del export
//    · Errores más claros para el usuario (permisos, tokens, etc.)
//
//  SEGURIDAD v12.0 (fixes sin cambio de lógica de negocio):
//    · Neutralización de inyección de fórmulas (= + - @) en Sheets exportados
//    · Escape de comillas simples/backslash al interpolar en SOQL
//    · La asignación reporta bloques de query fallidos (antes fallaban en silencio)
//    · Versión de API de Salesforce centralizada en SF_API_VERSION
// ══════════════════════════════════════════════════════════════════════════


// ══════════════════════════════════════════════════════════════════════════
//  CONFIGURACIÓN
// ══════════════════════════════════════════════════════════════════════════
var SF_API_VERSION          = "v62.0";  // ← Versión de la API de Salesforce (un solo lugar para subirla)
var VERSION_BACKEND         = "17.1";
var GOOGLE_CLIENT_ID        = "568964808002-hftmn4qnjikpfn4l8u6vefbqjjd63b5k.apps.googleusercontent.com";
var ALLOWED_DOMAIN          = "docplanner.com";

// ── CONFIGURACIÓN PRIVADA (v17.1) ──
// DEFAULT_DRIVE_FOLDER_ID, ALLOWED_EMAILS, ADMIN_EMAILS y AUDIT_SHEET_ID viven en
// backend/config.local.gs: está en .gitignore porque el repo es público, y clasp lo sube
// a Apps Script junto con este archivo. Plantilla: docs/config.ejemplo.gs.

// ── ADMIN v15: whitelist dinámica ──
// La lista de usuarios vive en la pestaña "Usuarios" del Sheet de auditoría y
// se administra SOLO desde el panel de la tool (nunca editando el Sheet a mano;
// la pestaña se crea y siembra sola la primera vez). ALLOWED_EMAILS (arriba)
// queda como FALLBACK: si el Sheet no responde, nadie pierde acceso.
var USUARIOS_SHEET_NAME  = "Usuarios";
var WHITELIST_CACHE_KEY  = "whitelist_v15";
var WHITELIST_CACHE_SEG  = 300;  // 5 min: un alta/baja tarda máx esto en propagarse

// ── SEGURIDAD: Rate limiting ──
// Máximo N operaciones costosas por email por hora.
// Protege contra bugs, bucles accidentales, y abuso.
var RATE_LIMIT_MAX_POR_HORA  = 100;
// NOTA v14: "jobStatus" queda FUERA a propósito. Es una consulta de ~1s que el
// frontend repite cada 5-15s mientras dura un import; con el tope de 100/hora un
// import largo agotaría el límite del propio usuario. No hay riesgo de abuso:
// requiere id_token válido + un jobId existente, y no descarga datos.
// v17: también cuentan describe, adminData y cualquier acción desconocida.
var RATE_LIMIT_OPERACIONES   = ["asignacion", "importStart", "exportSheet", "exportSheetFromFile", "recuperarJob",
                                "describe", "adminData", "adminAddUser", "adminRemoveUser", "(desconocida)"];

// ── v17 · LISTAS PERMITIDAS ──
// Solo estas acciones existen. Cualquier otra se rechaza (antes caía en la asignación).
var ACCIONES_PERMITIDAS = ["asignacion", "describe", "importStart", "jobStatus", "recuperarJob",
                           "exportSheet", "exportSheetFromFile", "adminData", "adminAddUser", "adminRemoveUser"];
// Acciones que mandan el SID a Salesforce: su instanceUrl debe ser de Salesforce.
var ACCIONES_CON_SID    = ["asignacion", "describe", "importStart", "jobStatus", "recuperarJob"];
var INSTANCE_URL_REGEX  = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.my\.salesforce\.com$/i;
var OBJECT_REGEX        = /^[A-Za-z0-9_]+$/;
var OPERACIONES_IMPORT  = ["insert", "upsert"];
var JOB_ID_REGEX        = /^750[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/;
var LOTE_ID_REGEX       = /^lote_[a-f0-9]{16}$/;
var JWT_REGEX           = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// ── v17 · IMPORT EN PARALELO ──
// Bulk API 2.0 procesa cada job en serie (transacciones de 200). Para que corra en
// paralelo hay que crear varios jobs. 500 filas → 5 jobs de 100.
var FILAS_POR_JOB          = 100;
var MAX_JOBS_PARALELO      = 10;
var IMPORT_IDEMP_SEG       = 21600;  // 6 h: un clientRequestId repetido devuelve los mismos jobs
var ERROR_LOCK             = "UNABLE_TO_LOCK_ROW";

// ── v17 · ASIGNACIÓN ──
var IDS_POR_QUERY          = 40;     // UrlFetchApp corta las URLs de más de 2 kB: 40 IDs caben con el query
var QUERIES_EN_PARALELO    = 10;     // bloques que van juntos en un fetchAll
var ASIGNACION_CORTE_MS    = 270000; // 4.5 min: se corta con aviso antes del límite de 6 min de Apps Script

// ── SEGURIDAD: campos que NUNCA se logean (sanitización) ──
var CAMPOS_SENSIBLES = ["sid", "idToken", "fileContent", "access_token", "accessToken", "password"];



function doPost(e) {
  var output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  var payload = null;
  var userEmail = "";
  var operation = "";

  try {
    payload = JSON.parse(e.postData.contents);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Petición inválida.");
    // v17: solo acciones conocidas. Lo demás queda como "(desconocida)" (nunca el texto
    // que mandó el cliente: el web app es anónimo y ese texto acabaría en el Sheet).
    operation = normalizarAccion(payload.action);

    // ── CAPA 1: validar id_token de Google (dominio + whitelist) ──
    var tokenValidation = validarIdToken(payload.idToken);
    if (!tokenValidation.valid) {
      // v17: un token que ni siquiera tiene forma de JWT se rechaza sin fetch y sin
      // auditoría (sería ruido de bots). Los demás rechazos sí se registran.
      if (!tokenValidation.basura) {
        registrarAuditoria(
          tokenValidation.email || "(desconocido)",
          operation,
          tokenValidation.notAuthorized ? "no_autorizado" : "auth_rechazado",
          tokenValidation.error
        );
      }
      output.setContent(JSON.stringify({
        error: tokenValidation.error,
        authError: true,
        notAuthorized: tokenValidation.notAuthorized === true
      }));
      return output;
    }
    userEmail = tokenValidation.email;
    // Sobreescribir el userEmail del payload con el verificado por Google
    payload.userEmail = userEmail;

    // ── CAPA 2: rate limiting para operaciones costosas (y acciones desconocidas) ──
    if (RATE_LIMIT_OPERACIONES.indexOf(operation) !== -1) {
      var rl = verificarRateLimit(userEmail);
      if (!rl.permitido) {
        registrarAuditoria(userEmail, operation, "rate_limited",
          "Excedió " + rl.max + "/hora. Reset en " + rl.resetEnMinutos + " min");
        output.setContent(JSON.stringify({
          error: "Alcanzaste el límite de " + rl.max + " operaciones por hora. " +
                 "Vuelve a intentar en aprox. " + rl.resetEnMinutos + " min.",
          rateLimited: true,
          resetEnMinutos: rl.resetEnMinutos
        }));
        return output;
      }
    }

    if (operation === "(desconocida)") throw new Error("Acción no válida.");

    // ── CAPA 3 · v17: el SID solo viaja a Salesforce, con objeto y operación conocidos ──
    if (ACCIONES_CON_SID.indexOf(operation) !== -1) validarParametrosSf(payload, operation);

    // ── EJECUTAR OPERACIÓN ──
    var resultado;
    if (operation === "importStart") {
      // v17: crea N jobs en paralelo y devuelve jobIds + loteId de inmediato.
      // La auditoría "iniciado" se escribe DENTRO, en cuanto Salesforce asigna los jobs.
      resultado = iniciarImportBulk(payload);
    } else if (operation === "jobStatus") {
      // Consulta corta que el frontend repite. Sin auditoría (sería ruido).
      resultado = consultarEstadoJob(payload);
    } else if (operation === "adminData") {
      // v15: panel admin. TODOS los usuarios de la whitelist pueden VER;
      // solo ADMIN_EMAILS puede editar (las acciones de abajo lo verifican).
      resultado = obtenerDatosAdmin(userEmail);
    } else if (operation === "adminAddUser") {
      resultado = adminAgregarUsuario(userEmail, payload);
    } else if (operation === "adminRemoveUser") {
      resultado = adminEliminarUsuario(userEmail, payload);
    } else if (operation === "describe") {
      resultado = describirObjeto(payload);
    } else if (operation === "recuperarJob") {
      resultado = recuperarResultadoJob(payload);
      // El flujo normal usa esta misma operación para traer los resultados al final
      // (cierreAutomatico): se audita como "import" para que las métricas lo cuenten.
      // El reintento por bloqueo va aparte para no contar dos veces las mismas filas.
      // v17: el estado es el real, no siempre "success".
      var opAudit = (payload.esReintentoLock === true) ? "reintentoLock"
                  : (payload.cierreAutomatico === true) ? "import" : "recuperarJob";
      registrarAuditoria(userEmail, opAudit, estadoAuditoriaRecuperar(resultado), detalleAuditoriaJobs(resultado));
    } else if (operation === "exportSheet") {
      resultado = exportarResultadoASheet(payload);
    } else if (operation === "exportSheetFromFile") {
      resultado = exportarSheetDesdeArchivo(payload);
    } else {
      resultado = procesarAsignacion(payload);
    }

    output.setContent(JSON.stringify(resultado));
  } catch (err) {
    // Logear el error SIN exponer credenciales
    var payloadSaneado = sanitizarPayload(payload);
    Logger.log("[ERROR] op=" + operation + " user=" + userEmail +
               " msg=" + err.message +
               " payload=" + JSON.stringify(payloadSaneado).slice(0, 800));

    // NO devolver stack trace al cliente (info leak)
    var respuesta = { error: err.message };
    // v17: el SID venció. El frontend para el sondeo y conserva el trabajo.
    if (err.sfSesionExpirada) respuesta.sfSessionExpired = true;
    output.setContent(JSON.stringify(respuesta));

    if ((operation === "importStart" || (operation === "recuperarJob" && payload && payload.cierreAutomatico === true)) &&
        !err.yaAuditado) {
      registrarAuditoria(userEmail, "import", "error", String(err.message).slice(0, 300));
    }
  }

  return output;
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: "OK", version: VERSION_BACKEND }))
    .setMimeType(ContentService.MimeType.JSON);
}

// v17: nombre de acción seguro para auditar y despachar.
function normalizarAccion(action) {
  if (action === undefined || action === null || action === "") return "asignacion";
  if (typeof action === "string" && ACCIONES_PERMITIDAS.indexOf(action) !== -1) return action;
  return "(desconocida)";
}

// v17: instanceUrl solo de Salesforce, object con caracteres de API Name, operation conocida.
// Sin esto, el SID del usuario se podía mandar a cualquier host.
function validarParametrosSf(p, operation) {
  var url = String(p.instanceUrl || "").replace(/\/+$/, "");
  if (!INSTANCE_URL_REGEX.test(url)) throw new Error("instanceUrl no permitido. Debe ser https://<org>.my.salesforce.com");
  p.instanceUrl = url;
  if (typeof p.sid !== "string" || !p.sid.trim()) throw new Error("Falta el Session ID (SID).");
  if (operation === "describe" || operation === "importStart") {
    if (p.object === undefined || p.object === null || p.object === "") p.object = "Lead";
    if (typeof p.object !== "string" || !OBJECT_REGEX.test(p.object)) throw new Error("Objeto no válido.");
  }
  if (operation === "importStart") {
    if (!p.operation) p.operation = "insert";
    if (OPERACIONES_IMPORT.indexOf(p.operation) === -1) {
      throw new Error("Operación no permitida: solo " + OPERACIONES_IMPORT.join(" y ") + ".");
    }
    if (p.operation === "upsert" && !OBJECT_REGEX.test(String(p.externalId || ""))) {
      throw new Error("Upsert necesita un External ID Field válido.");
    }
  }
}

// v17: error que el frontend reconoce como "pega un SID nuevo" (401 de Salesforce).
function errorSesionSf(contexto) {
  var e = new Error("Tu sesión de Salesforce expiró (" + contexto + "). Pega un SID nuevo. " +
                    "Si había un import corriendo, sigue en Salesforce: recupéralo con su Job ID o Lote.");
  e.sfSesionExpirada = true;
  return e;
}


// ══════════════════════════════════════════════════════════════════════════
//  VALIDACIÓN DE id_token DE GOOGLE
//  Verifica el JWT contra el endpoint oficial de Google (tokeninfo).
//  v17: caché por SHA-256 del token completo, nunca más allá de su exp, y
//  revalidando la whitelist en cada uso (una baja corta el acceso al momento).
// ══════════════════════════════════════════════════════════════════════════
function validarIdToken(idToken) {
  if (!idToken || typeof idToken !== "string") {
    return { valid: false, error: "No se envió id_token", basura: true };
  }
  if (idToken.length > 4096 || !JWT_REGEX.test(idToken)) {
    return { valid: false, error: "Token con formato inválido", basura: true };
  }
  var claims = leerClaimsJwt(idToken);
  if (!claims || !claims.exp) {
    return { valid: false, error: "Token con formato inválido", basura: true };
  }
  var ahora = Math.floor(Date.now() / 1000);
  if (Number(claims.exp) < ahora) {
    return { valid: false, error: "Sesión expirada. Vuelve a iniciar sesión." };
  }

  var cache = CacheService.getScriptCache();
  var cacheKey = "tok_" + hashTexto(idToken);
  var cached = cache.get(cacheKey);
  if (cached) {
    try {
      var c = JSON.parse(cached);
      if (c.exp > ahora && obtenerWhitelist().indexOf(c.email) !== -1) return { valid: true, email: c.email };
    } catch (e) {}
    cache.remove(cacheKey);  // vencido o dado de baja: se verifica de nuevo abajo
  }

  try {
    var res = UrlFetchApp.fetch(
      "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken),
      { method: "get", muteHttpExceptions: true }
    );

    if (res.getResponseCode() !== 200) {
      return { valid: false, error: "Google rechazó el token (HTTP " + res.getResponseCode() + ")" };
    }

    var info = JSON.parse(res.getContentText());

    // Verificar audience (que el token fue emitido para NUESTRA app)
    if (info.aud !== GOOGLE_CLIENT_ID) {
      return { valid: false, error: "Token emitido para otra aplicación" };
    }

    // Verificar dominio hosted domain
    if (info.hd !== ALLOWED_DOMAIN) {
      return { valid: false, error: "Dominio no autorizado: " + (info.hd || "sin dominio") };
    }

    // Verificar email verificado
    if (info.email_verified !== "true" && info.email_verified !== true) {
      return { valid: false, error: "Email no verificado por Google" };
    }

    // Verificar expiración
    var exp = parseInt(info.exp, 10);
    if (!(exp >= ahora)) {
      return { valid: false, error: "Sesión expirada. Vuelve a iniciar sesión." };
    }

    // Verificar whitelist de emails (última capa antes de permitir acceso)
    // v15: la lista viene de la pestaña "Usuarios" del Sheet (editable desde el
    // panel admin de la tool). Si el Sheet falla, obtenerWhitelist() cae de
    // vuelta a ALLOWED_EMAILS — un problema de Sheet nunca bloquea a todos.
    var emailLower = String(info.email).toLowerCase().trim();
    if (obtenerWhitelist().indexOf(emailLower) === -1) {
      return {
        valid: false,
        error: "Tu email no está autorizado para usar esta herramienta. Contacta a RevOps si necesitas acceso.",
        notAuthorized: true,
        email: emailLower
      };
    }

    // Cachear hasta 5 min, nunca más allá del exp del token
    var ttl = Math.min(300, exp - ahora);
    if (ttl >= 1) cache.put(cacheKey, JSON.stringify({ email: emailLower, exp: exp }), ttl);

    return { valid: true, email: emailLower };
  } catch (err) {
    return { valid: false, error: "Excepción validando token: " + err.message };
  }
}

// Lee el payload del JWT (sin verificar la firma: eso lo hace Google en tokeninfo).
function leerClaimsJwt(token) {
  try {
    var parte = token.split(".")[1];
    while (parte.length % 4) parte += "=";
    var bytes = Utilities.base64DecodeWebSafe(parte);
    var obj = JSON.parse(Utilities.newBlob(bytes).getDataAsString("UTF-8"));
    return (obj && typeof obj === "object") ? obj : null;
  } catch (e) {
    return null;
  }
}

function hashTexto(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, "");
}


// ══════════════════════════════════════════════════════════════════════════
//  SANITIZACIÓN — Quita credenciales de payloads antes de logear
//  Uso: cuando un error dispara Logger.log(), NUNCA debe logear sid o idToken.
// ══════════════════════════════════════════════════════════════════════════
function sanitizarPayload(payload) {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload !== "object") return payload;

  var esArray = Array.isArray(payload);
  var copia = esArray ? [] : {};

  for (var key in payload) {
    if (!payload.hasOwnProperty(key)) continue;
    var val = payload[key];

    if (CAMPOS_SENSIBLES.indexOf(key) !== -1) {
      // Redactar completamente los campos sensibles
      copia[key] = "[REDACTED]";
    } else if (Array.isArray(val)) {
      // Arrays grandes: solo mostrar tamaño para no llenar logs
      copia[key] = val.length > 3
        ? "[Array len=" + val.length + "]"
        : val.map(function(x) { return sanitizarPayload(x); });
    } else if (typeof val === "object" && val !== null) {
      copia[key] = sanitizarPayload(val);
    } else if (typeof val === "string" && val.length > 200) {
      copia[key] = val.slice(0, 200) + "...[truncated]";
    } else {
      copia[key] = val;
    }
  }
  return copia;
}


// ══════════════════════════════════════════════════════════════════════════
//  RATE LIMITING — Max N operaciones costosas por email por hora
//  Usa CacheService con TTL 1h. Key: "rate_<email>_<hourBucket>".
// ══════════════════════════════════════════════════════════════════════════
function verificarRateLimit(email) {
  var cache = CacheService.getScriptCache();
  var now = Date.now();
  var hourBucket = Math.floor(now / 3600000);
  var key = "rate_" + email + "_" + hourBucket;

  // v17: leer y sumar bajo candado. Sin esto, dos peticiones a la vez leían el
  // mismo contador y el tope se podía pasar.
  var lock = LockService.getScriptLock();
  var conCandado = false;
  try { conCandado = lock.tryLock(5000); } catch (e) {}
  try {
    var actual = parseInt(cache.get(key) || "0", 10);
    if (actual >= RATE_LIMIT_MAX_POR_HORA) {
      var msRestantes = 3600000 - (now % 3600000);
      return {
        permitido: false,
        actual: actual,
        max: RATE_LIMIT_MAX_POR_HORA,
        resetEnMinutos: Math.ceil(msRestantes / 60000)
      };
    }
    cache.put(key, String(actual + 1), 3600);  // TTL 1 hora
    return {
      permitido: true,
      actual: actual + 1,
      max: RATE_LIMIT_MAX_POR_HORA
    };
  } finally {
    if (conCandado) lock.releaseLock();
  }
}


// ══════════════════════════════════════════════════════════════════════════
//  AUDITORÍA — Registra imports y eventos de seguridad
//  Solo se activa si AUDIT_SHEET_ID está configurado.
//  Registra: imports (success/error), auth_rechazado, no_autorizado, rate_limited.
//
//  Los errores NUNCA rompen el flujo principal — solo se logean.
//  Para debuggear, ejecuta manualmente testAuditoria() desde el editor.
// ══════════════════════════════════════════════════════════════════════════
function registrarAuditoria(userEmail, operation, status, details) {
  if (!AUDIT_SHEET_ID) {
    Logger.log("[AUDIT SKIP] AUDIT_SHEET_ID no configurado (const en el backend está vacío).");
    return { logged: false, reason: "AUDIT_SHEET_ID vacío" };
  }
  try {
    var ss = SpreadsheetApp.openById(AUDIT_SHEET_ID);
    var sheet = ss.getSheets()[0];

    // Auto-crear headers si el sheet está vacío
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["Timestamp", "Email", "Operación", "Estado", "Detalles"]);
      sheet.getRange(1, 1, 1, 5)
           .setFontWeight("bold")
           .setBackground("#1e2235")
           .setFontColor("#ffffff");
      sheet.setFrozenRows(1);
      sheet.setColumnWidth(1, 160);
      sheet.setColumnWidth(2, 240);
      sheet.setColumnWidth(3, 130);
      sheet.setColumnWidth(4, 130);
      sheet.setColumnWidth(5, 500);
    }

    // v17: todo pasa por neutralizarValorSheet. El web app es anónimo: un email,
    // operación o detalle que empiece con "=" se escribía como fórmula.
    sheet.appendRow([
      new Date(),
      neutralizarValorSheet(String(userEmail || "(vacío)").slice(0, 200)),
      neutralizarValorSheet(String(operation || "(vacío)").slice(0, 60)),
      neutralizarValorSheet(String(status || "(vacío)").slice(0, 60)),
      neutralizarValorSheet(String(details || "").slice(0, 500))
    ]);
    Logger.log("[AUDIT OK] " + operation + " · " + status + " · " + userEmail);
    return { logged: true };
  } catch (err) {
    Logger.log("[AUDIT FAIL] " + err.message + " | sheetId=" + AUDIT_SHEET_ID);
    return { logged: false, reason: err.message };
  }
}


// ══════════════════════════════════════════════════════════════════════════
//  TEST DE AUTORIZACIÓN DE SCOPES — Ejecuta esta función manualmente
//  UNA SOLA VEZ desde el editor para autorizar TODOS los scopes que la
//  herramienta necesita. Es la forma correcta de autorizar sin recibir
//  el error "TypeError: params undefined" que dan las funciones reales.
// ══════════════════════════════════════════════════════════════════════════
function testAutorizarScopes() {
  Logger.log("═══════════════════════════════════════════════");
  Logger.log("  TEST DE AUTORIZACIÓN DE SCOPES");
  Logger.log("═══════════════════════════════════════════════");
  Logger.log("Cuenta actual: " + Session.getEffectiveUser().getEmail());
  Logger.log("");

  var archivosTemp = [];

  try {
    Logger.log("Paso 1/6: Verificando SpreadsheetApp.create...");
    var ss = SpreadsheetApp.create("TEST_AUTORIZACION_" + new Date().getTime());
    archivosTemp.push(ss.getId());
    Logger.log("  ✓ Scope de SpreadsheetApp OK");
    Logger.log("  Sheet creado: " + ss.getName());

    Logger.log("");
    Logger.log("Paso 2/6: Verificando DriveApp.createFile (upload de archivos)...");
    var blob = Utilities.newBlob("test", "text/plain", "test_autorizacion.txt");
    var file = DriveApp.createFile(blob);
    archivosTemp.push(file.getId());
    Logger.log("  ✓ Scope de DriveApp.createFile OK");

    Logger.log("");
    Logger.log("Paso 3/6: Verificando DriveApp.getFileById + moveTo (mover a carpeta)...");
    var driveFile = DriveApp.getFileById(ss.getId());
    var folder = DriveApp.getFolderById(DEFAULT_DRIVE_FOLDER_ID);
    driveFile.moveTo(folder);
    Logger.log("  ✓ Scope de mover a carpeta OK");
    Logger.log("  Archivo movido a: " + folder.getName());

    Logger.log("");
    Logger.log("Paso 4/6: Verificando UrlFetchApp (para validar id_token)...");
    var res = UrlFetchApp.fetch(
      "https://oauth2.googleapis.com/tokeninfo?id_token=dummy",
      { method: "get", muteHttpExceptions: true }
    );
    Logger.log("  ✓ Scope de UrlFetchApp OK (código HTTP: " + res.getResponseCode() + ")");

    Logger.log("");
    Logger.log("Paso 5/6: Verificando CacheService (para rate limiting)...");
    CacheService.getScriptCache().put("test_scope", "ok", 60);
    var cached = CacheService.getScriptCache().get("test_scope");
    Logger.log("  ✓ CacheService OK (valor recuperado: " + cached + ")");

    Logger.log("");
    Logger.log("Paso 6/6: Verificando escritura al Audit Sheet (si está configurado)...");
    if (AUDIT_SHEET_ID) {
      var result = registrarAuditoria("test-autorizacion@docplanner.com", "test_autorizar", "success", "Test de scopes");
      if (result.logged) {
        Logger.log("  ✓ Auditoría OK");
      } else {
        Logger.log("  ⚠ Auditoría con problema: " + result.reason);
      }
    } else {
      Logger.log("  ℹ AUDIT_SHEET_ID vacío (opcional, no bloqueante).");
    }

    Logger.log("");
    Logger.log("═══════════════════════════════════════════════");
    Logger.log("  ✅ TODOS LOS SCOPES AUTORIZADOS");
    Logger.log("═══════════════════════════════════════════════");
    Logger.log("La herramienta ya puede ejecutar todas sus funciones");
    Logger.log("(asignación, import, export, subir archivos, etc).");

  } catch (err) {
    Logger.log("");
    Logger.log("═══════════════════════════════════════════════");
    Logger.log("  ❌ ERROR: " + err.message);
    Logger.log("═══════════════════════════════════════════════");
    Logger.log("");
    Logger.log("Posibles causas:");
    Logger.log("  1. Aún hay un popup de autorización pendiente.");
    Logger.log("     → Cierra este log, vuelve a ejecutar, acepta permisos.");
    Logger.log("");
    Logger.log("  2. La carpeta COE (" + DEFAULT_DRIVE_FOLDER_ID + ")");
    Logger.log("     no está compartida con " + Session.getEffectiveUser().getEmail());
    Logger.log("     → Comparte la carpeta como Editor.");
    Logger.log("");
    Logger.log("  3. Un scope específico fue rechazado en el popup anterior.");
    Logger.log("     → Ve a myaccount.google.com/permissions, quita este");
    Logger.log("     script, y vuelve a autorizar.");

  } finally {
    // Limpieza: enviar a papelera todos los archivos temporales creados
    Logger.log("");
    Logger.log("Limpiando archivos temporales...");
    archivosTemp.forEach(function(fid) {
      try { DriveApp.getFileById(fid).setTrashed(true); } catch (e) {}
    });
    Logger.log("  ✓ Limpieza completada.");
  }
}


// ══════════════════════════════════════════════════════════════════════════
//  TEST DE AUDITORÍA — Ejecuta esta función manualmente desde el editor
//  para verificar que el AUDIT_SHEET_ID esté correctamente configurado
//  y que el script tenga permisos sobre el Sheet.
//
//  Cómo usar:
//    1. En el editor de Apps Script, selecciona esta función en el dropdown
//    2. Presiona Ejecutar (▶)
//    3. Revisa los logs (menú Ejecución → Ver logs, o Ctrl+Enter)
//    4. Si dice ✅ ÉXITO, ve al Sheet y verifica que apareció una fila de test
// ══════════════════════════════════════════════════════════════════════════
function testAuditoria() {
  Logger.log("═══════════════════════════════════════════════");
  Logger.log("  TEST DE AUDITORÍA — SF ASIGNADOR");
  Logger.log("═══════════════════════════════════════════════");
  Logger.log("AUDIT_SHEET_ID configurado: " + (AUDIT_SHEET_ID || "(VACÍO)"));

  if (!AUDIT_SHEET_ID) {
    Logger.log("");
    Logger.log("❌ FALLA: AUDIT_SHEET_ID está vacío.");
    Logger.log("   Configúralo en la línea del backend:");
    Logger.log("   var AUDIT_SHEET_ID = \"tu_id_aqui\";");
    return;
  }

  try {
    Logger.log("");
    Logger.log("Paso 1: Intentando abrir el Sheet...");
    var ss = SpreadsheetApp.openById(AUDIT_SHEET_ID);
    Logger.log("  ✓ Sheet abierto correctamente");
    Logger.log("  Nombre: " + ss.getName());
    Logger.log("  URL:    " + ss.getUrl());

    Logger.log("");
    Logger.log("Paso 2: Accediendo a la primera hoja...");
    var sheet = ss.getSheets()[0];
    Logger.log("  ✓ Hoja: " + sheet.getName());
    Logger.log("  Filas actuales: " + sheet.getLastRow());

    Logger.log("");
    Logger.log("Paso 3: Escribiendo fila de test...");
    var result = registrarAuditoria(
      "test-manual@docplanner.com",
      "test",
      "success",
      "Test manual desde editor de Apps Script — " + new Date().toISOString()
    );
    Logger.log("  Resultado: " + JSON.stringify(result));

    if (result.logged) {
      Logger.log("");
      Logger.log("═══════════════════════════════════════════════");
      Logger.log("  ✅ ÉXITO");
      Logger.log("═══════════════════════════════════════════════");
      Logger.log("La auditoría está funcionando correctamente.");
      Logger.log("Ve al Sheet y verifica que aparezca la fila de test:");
      Logger.log(ss.getUrl());
    } else {
      Logger.log("");
      Logger.log("❌ FALLÓ AL ESCRIBIR: " + result.reason);
    }

  } catch (err) {
    Logger.log("");
    Logger.log("═══════════════════════════════════════════════");
    Logger.log("  ❌ EXCEPCIÓN: " + err.message);
    Logger.log("═══════════════════════════════════════════════");
    Logger.log("Posibles causas:");
    Logger.log("  1) El Sheet no existe con el ID especificado.");
    Logger.log("     → Verifica que el ID sea correcto y esté en Drive.");
    Logger.log("");
    Logger.log("  2) La cuenta que desplegó el script no tiene permiso de Editor.");
    Logger.log("     → Comparte el Sheet con esa cuenta como Editor.");
    Logger.log("");
    Logger.log("  3) El scope de Sheets/Drive no está autorizado.");
    Logger.log("     → Corre esta función una vez para forzar re-autorización.");
    Logger.log("");
    Logger.log("Cuenta actual del script: " + Session.getEffectiveUser().getEmail());
  }
}


// ══════════════════════════════════════════════════════════════════════════
//  DESCRIBE
// ══════════════════════════════════════════════════════════════════════════
function describirObjeto(params) {
  var url = params.instanceUrl + "/services/data/" + SF_API_VERSION + "/sobjects/" + params.object + "/describe";
  try {
    var res = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { "Authorization": "Bearer " + params.sid, "Accept": "application/json" },
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    var text = res.getContentText();
    if (code === 401) return { error: errorSesionSf("describe").message, sfSessionExpired: true, httpCode: 401 };
    if (code !== 200) return { error: "Salesforce devolvió HTTP " + code + ": " + text.slice(0, 400), httpCode: code };
    var data;
    try { data = JSON.parse(text); } catch (e) { return { error: "Respuesta no es JSON válido: " + text.slice(0, 300) }; }
    if (!data.fields || !Array.isArray(data.fields)) return { error: "Respuesta sin array de fields" };

    // Construir metadata detallada de cada campo (para validación de tipos en frontend)
    var fieldsMetadata = {};
    data.fields.forEach(function(f) {
      fieldsMetadata[f.name] = {
        name: f.name,
        label: f.label || f.name,
        type: f.type || "string",
        length: f.length || 0,
        nillable: f.nillable === true,
        updateable: f.updateable === true,
        createable: f.createable === true,
        defaultedOnCreate: f.defaultedOnCreate === true,
        picklistValues: (f.picklistValues || [])
          .filter(function(pv) { return pv.active !== false; })
          .map(function(pv) { return pv.value; })
      };
    });

    return {
      object: params.object,
      fields: data.fields.map(function(f){ return f.name; }),
      fieldsMetadata: fieldsMetadata
    };
  } catch (err) {
    return { error: "Excepción en describe: " + err.message };
  }
}


// ══════════════════════════════════════════════════════════════════════════
//  ASIGNACIÓN
// ══════════════════════════════════════════════════════════════════════════
function procesarAsignacion(params) {
  var sessionId    = params.sid;
  var instanceUrl  = params.instanceUrl;
  var businessLine = params.businessLine;
  var repsRaw      = Array.isArray(params.reps) ? params.reps : [];
  var idsRaw       = Array.isArray(params.ids) ? params.ids : [];
  var extraFieldsRaw  = params.extraFields   || [];  // Campos custom del Contact (columnas adicionales)
  var fieldsFromSFRaw = params.fieldsFromSF  || [];  // Campos base cuyo valor debe venir de SF en vez del hardcoded
  var inicioMs     = Date.now();

  // v17: IDs válidos (15/18 alfanuméricos) y sin repetir (15 primeros caracteres,
  // respetando mayúsculas). Antes un ID mal pegado hacía fallar su bloque de 40 entero.
  var idsContactos = [], idsInvalidos = [], idsRepetidos = 0, vistosIds = {};
  idsRaw.forEach(function(id) {
    var s = String(id === null || id === undefined ? "" : id).trim();
    if (!s) return;
    if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(s)) { idsInvalidos.push(s.slice(0, 40)); return; }
    var k = s.slice(0, 15);
    if (vistosIds[k]) { idsRepetidos++; return; }
    vistosIds[k] = true;
    idsContactos.push(s);
  });
  if (!idsContactos.length) throw new Error("No hay IDs de contactos válidos." +
    (idsInvalidos.length ? " Inválidos: " + idsInvalidos.slice(0, 5).join(", ") : ""));

  // v17: reps sin repetir (gana la primera aparición) y con cuota entera >= 0.
  var reps = [], repsRepetidos = [], vistosReps = {};
  repsRaw.forEach(function(r) {
    if (!r) return;
    var em = String(r.email || "").trim().toLowerCase();
    if (!em) return;
    if (vistosReps[em]) { repsRepetidos.push(em); return; }
    vistosReps[em] = true;
    var cuota = parseInt(r.cuota, 10);
    reps.push({ email: String(r.email).trim(), cuota: (cuota > 0 && cuota <= 100000) ? cuota : 0 });
  });
  if (!reps.length) throw new Error("No hay representantes válidos.");

  // v17: días entero entre 0 y 3650.
  var dias = params.dias;
  if (dias !== "" && dias !== null && dias !== undefined) {
    var dn = Number(dias);
    if (!isFinite(dn) || dn < 0 || dn > 3650 || Math.floor(dn) !== dn) throw new Error("Días debe ser un número entero entre 0 y 3650.");
  }

  // ── Validación de campos custom (SF o Manual) ──
  // extraFields puede ser array de strings (legacy) o array de objetos {name, mode, value?}
  var CAMPOS_BASE = {
    "Contact__c":1, "LastSourceAt__c":1, "Company":1, "LastName":1, "Email":1,
    "OwnerId":1, "BusinessLine__c":1, "Lead_Type__c":1, "ContactTypeSegment__c":1,
    "Country__c":1, "Leadassist__Use_Round_Robin__c":1, "Status":1, "FacilitySize__c":1
  };
  var VALID_FIELD_REGEX = /^[A-Za-z][A-Za-z0-9_]*$/;
  var extraFields = [];         // Todos: [{name, mode, value?}]
  var extraFieldsSF = [];       // Solo los mode='sf' (deben ir al SELECT del Contact)
  var extraFieldsRechazados = [];

  extraFieldsRaw.forEach(function(f) {
    var name, mode, value;
    if (typeof f === "string") {
      // Compatibilidad legacy
      name = String(f).trim();
      mode = "sf";
      value = null;
    } else if (f && typeof f === "object") {
      name = String(f.name || "").trim();
      mode = (f.mode === "manual") ? "manual" : "sf";
      value = (mode === "manual") ? String(f.value !== undefined && f.value !== null ? f.value : "") : null;
    } else {
      return;
    }

    if (!name) return;
    if (name.indexOf("__") === 0) {
      extraFieldsRechazados.push({ name: name, reason: "no puede empezar con __" });
      return;
    }
    if (!VALID_FIELD_REGEX.test(name)) {
      extraFieldsRechazados.push({ name: name, reason: "caracteres inválidos" });
      return;
    }
    if (CAMPOS_BASE[name]) {
      extraFieldsRechazados.push({ name: name, reason: "ya es un campo base" });
      return;
    }
    // Evitar duplicados
    if (extraFields.some(function(x) { return x.name === name; })) return;

    var cf = { name: name, mode: mode };
    if (mode === "manual") cf.value = value;
    extraFields.push(cf);
    if (mode === "sf") extraFieldsSF.push(cf);
  });

  // ── Validación de campos fijos que se traen de SF ──
  // Solo permitimos que los siguientes campos "hardcodeados" del pre-template
  // sean sobrescritos por el valor real del Contact
  var CAMPOS_FIJOS_SOBRESCRIBIBLES = {
    "BusinessLine__c":1, "Lead_Type__c":1, "ContactTypeSegment__c":1,
    "Country__c":1, "Leadassist__Use_Round_Robin__c":1, "Status":1, "FacilitySize__c":1
  };
  var fieldsFromSF = [];
  fieldsFromSFRaw.forEach(function(f) {
    var name = String(f || "").trim();
    if (CAMPOS_FIJOS_SOBRESCRIBIBLES[name] && fieldsFromSF.indexOf(name) === -1) {
      fieldsFromSF.push(name);
    }
  });

  // ── Campos fijos que el usuario decidió OCULTAR del pre-template ──
  // Los mismos 7 campos configurables pueden ser removidos completamente.
  // Si un campo está oculto, NO aparece en headers ni en las filas del pre-template.
  var camposFijosOcultosRaw = params.camposFijosOcultos || [];
  var camposFijosOcultos = {};  // usar objeto como set para lookup rápido
  camposFijosOcultosRaw.forEach(function(f) {
    var name = String(f || "").trim();
    if (CAMPOS_FIJOS_SOBRESCRIBIBLES[name]) camposFijosOcultos[name] = true;
  });
  // Si un campo está oculto, quitarlo también de fieldsFromSF (ya no aplica)
  fieldsFromSF = fieldsFromSF.filter(function(n) { return !camposFijosOcultos[n]; });

  // ── Campos fijos en modo MANUAL ──
  // El usuario define un valor propio a estampar idéntico en todas las filas.
  // Estructura recibida: { "FacilitySize__c": "Mid", "Country__c": "Colombia" }
  // Prioridad: manual gana sobre fromSF y sobre el default hardcodeado.
  var fieldsManualRaw = params.fieldsManualValues || {};
  var fieldsManualValues = {};  // solo los válidos
  Object.keys(fieldsManualRaw).forEach(function(name) {
    var n = String(name || "").trim();
    if (!CAMPOS_FIJOS_SOBRESCRIBIBLES[n]) return;       // solo campos permitidos
    if (camposFijosOcultos[n]) return;                  // si está oculto, ignorar
    fieldsManualValues[n] = String(fieldsManualRaw[name] !== undefined && fieldsManualRaw[name] !== null ? fieldsManualRaw[name] : "");
  });
  // Un campo en modo manual NO debe estar también en fromSF (manual tiene prioridad)
  fieldsFromSF = fieldsFromSF.filter(function(n) { return !fieldsManualValues.hasOwnProperty(n); });


  var opciones = {
    "method": "GET",
    "headers": { "Authorization": "Bearer " + sessionId, "Content-Type": "application/json" },
    "muteHttpExceptions": true
  };

  // v17: solo usuarios activos, y se revisa el código HTTP (401 = SID vencido).
  var emailsList = reps.map(function(r) { return "'" + escapeSoql(r.email) + "'"; });
  var soqlUsers = "SELECT Id, Email, Username FROM User WHERE (Email IN (" + emailsList.join(",") + ") OR Username IN (" + emailsList.join(",") + ")) AND IsActive = true";
  var urlUsers  = instanceUrl + "/services/data/" + SF_API_VERSION + "/query/?q=" + encodeURIComponent(soqlUsers);
  var resUsers  = UrlFetchApp.fetch(urlUsers, opciones);
  var codeUsers = resUsers.getResponseCode();
  if (codeUsers === 401) throw errorSesionSf("al buscar los reps");
  var jsonUsers;
  try { jsonUsers = JSON.parse(resUsers.getContentText()); } catch (e) { jsonUsers = {}; }
  if (codeUsers !== 200 || !jsonUsers.records) {
    throw new Error("Salesforce no devolvió los usuarios (HTTP " + codeUsers + "). Verifica el SID. " + JSON.stringify(jsonUsers).slice(0, 300));
  }

  var mapUserIds = {};
  jsonUsers.records.forEach(function(u) {
    if (u.Email)    mapUserIds[u.Email.toLowerCase().trim()]    = u.Id;
    if (u.Username) mapUserIds[u.Username.toLowerCase().trim()] = u.Id;
  });

  var cuotasReps = {};
  reps.forEach(function(r) { cuotasReps[r.email.toLowerCase().trim()] = r.cuota; });

  // El valor de días se usa tal cual: puede ser 0, 30, 60, 90, etc.
  // Si el usuario deja el campo vacío, se toma como 0 (query se ejecuta con LAST_N_DAYS:0).
  var diasFinal = (dias === "" || dias === null || dias === undefined) ? 0 : Number(dias);
  var poolContactos = [];
  var bloquesFallidos = 0;  // v12.0: bloques de query que fallaron (antes se perdían en silencio)
  var erroresBloques = [];
  var idsSinConsultar = 0;  // v17: IDs que no alcanzaron a consultarse por el corte de tiempo

  // ÚNICA query de asignación: siempre usa la exclusión con LAST_N_DAYS.
  // Excluye contactos con Opportunities abiertas o cerradas en los últimos N días,
  // y contactos con Leads NO convertidos en estados activos o cerrados en los últimos N días.
  // Construir SELECT dinámico: 5 campos base + extraFieldsSF (columnas custom desde Contact) + fieldsFromSF (sobrescriben hardcodeados)
  // Los custom manuales NO van al SELECT porque su valor es fijo y no depende del Contact
  var selectFields = ["Id", "LastSourceAt__c", "Account.Name", "LastName", "Email"];
  for (var ef0 = 0; ef0 < extraFieldsSF.length; ef0++) selectFields.push(extraFieldsSF[ef0].name);
  for (var fi0 = 0; fi0 < fieldsFromSF.length; fi0++) {
    if (selectFields.indexOf(fieldsFromSF[fi0]) === -1) selectFields.push(fieldsFromSF[fi0]);
  }
  var selectClause = selectFields.join(", ");

  // Un bloque = IDS_POR_QUERY IDs (UrlFetchApp corta URLs de más de 2 kB).
  // v17: los bloques van de QUERIES_EN_PARALELO en QUERIES_EN_PARALELO con fetchAll.
  var bloques = [];
  for (var i = 0; i < idsContactos.length; i += IDS_POR_QUERY) {
    var bloque = idsContactos.slice(i, i + IDS_POR_QUERY);
    var idsFormateados = bloque.map(function(id) { return "'" + escapeSoql(String(id).trim()) + "'"; }).join(",");
    var soqlContactos =
      "SELECT " + selectClause + " " +
      "FROM Contact WHERE Id IN (" + idsFormateados + ") " +
      "AND Id NOT IN (" +
        "SELECT contact__c FROM Opportunity " +
        "WHERE contact__c != NULL " +
        "AND (IsClosed = False OR (IsClosed = True AND CloseDate = LAST_N_DAYS:" + diasFinal + "))" +
      ") " +
      "AND Id NOT IN (" +
        "SELECT contact__c FROM Lead " +
        "WHERE contact__c != NULL " +
        "AND IsConverted = false " +
        "AND (Status IN ('New','Assigned','Qualifying') OR lead_closed_date__c = LAST_N_DAYS:" + diasFinal + ")" +
      ")";
    bloques.push({ n: bloque.length, url: instanceUrl + "/services/data/" + SF_API_VERSION + "/query/?q=" + encodeURIComponent(soqlContactos) });
  }

  for (var g = 0; g < bloques.length; g += QUERIES_EN_PARALELO) {
    // Corte claro antes del límite de 6 min de Apps Script
    if (Date.now() - inicioMs > ASIGNACION_CORTE_MS) {
      for (var rest = g; rest < bloques.length; rest++) idsSinConsultar += bloques[rest].n;
      break;
    }
    var grupo = bloques.slice(g, g + QUERIES_EN_PARALELO);
    var respuestas;
    try {
      respuestas = sfFetchAll(grupo.map(function(b) { return { url: b.url, method: "get", headers: opciones.headers }; }));
    } catch (err) {
      bloquesFallidos += grupo.length;
      erroresBloques.push("Excepción: " + err.message);
      continue;
    }
    for (var k = 0; k < respuestas.length; k++) {
      var r = respuestas[k];
      if (r.code === 401) throw errorSesionSf("al consultar los contactos");
      var jsonContactos = null;
      try { jsonContactos = JSON.parse(r.text); } catch (e) {}
      if (r.code !== 200 || !jsonContactos || !jsonContactos.records) {
        bloquesFallidos++;
        if (erroresBloques.length < 3) erroresBloques.push("HTTP " + r.code + ": " + String(r.text).slice(0, 200));
        continue;
      }
      jsonContactos.records.forEach(function(c) {
        var filaPool = [
          c.Id,
          serializarValor(c.LastSourceAt__c),
          c.Account && c.Account.Name ? c.Account.Name : "",
          serializarValor(c.LastName),
          serializarValor(c.Email)
        ];
        // Añadir valores de los custom fields en modo SF (los manuales se estampan al armar la fila)
        for (var ef = 0; ef < extraFieldsSF.length; ef++) {
          filaPool.push(serializarValor(c[extraFieldsSF[ef].name]));
        }
        // Añadir valores de los fields traídos de SF (para sobreescribir hardcodeados)
        for (var fi = 0; fi < fieldsFromSF.length; fi++) {
          filaPool.push(serializarValor(c[fieldsFromSF[fi]]));
        }
        poolContactos.push(filaPool);
      });
    }
  }

  var matrizPreTemplate = [];
  var punteroContacto   = 0;

  // ── Lead_Type__c viene del dropdown del frontend (control total del usuario) ──
  // Default en frontend es "New Business". Validamos que sea uno de los dos valores permitidos.
  var leadTypeInput = String(params.leadType || "").trim();
  var leadTypeVal = (leadTypeInput === "Existing Business") ? "Existing Business" : "New Business";

  // Valores DEFAULT hardcodeados de los campos fijos.
  // Si el usuario configuró un campo para venir de SF, se sobrescribe con el valor real del Contact.
  var DEFAULTS_HARDCODED = {
    "BusinessLine__c": businessLine,
    "Lead_Type__c": leadTypeVal,
    "ContactTypeSegment__c": "DOCTOR",
    "Country__c": "Mexico",
    "Leadassist__Use_Round_Robin__c": "FALSE",
    "Status": "Assigned",
    "FacilitySize__c": ""
  };

  var leadsPorOwner    = {};
  var ownersNotFound   = [];  // Emails cuyo OwnerId NO se encontró en Salesforce

  reps.forEach(function(rep) {
    var email   = rep.email.toString().trim().toLowerCase();
    if (email === "") return;
    var ownerId = mapUserIds[email];
    var cuota   = cuotasReps[email] || 0;
    var assigned = 0;

    if (!ownerId) {
      // No se encontró Owner en Salesforce — se registra y NO se le asignan leads
      ownersNotFound.push(rep.email);
      leadsPorOwner[email] = { email: rep.email, ownerId: "NOT_FOUND", count: 0, notFound: true };
      return;
    }

    for (var k = 0; k < cuota; k++) {
      if (punteroContacto >= poolContactos.length) break;
      var datosContacto = poolContactos[punteroContacto++];
      // Estructura del pool: [5 base] + [N custom SF] + [M fromSF]
      var baseCto        = datosContacto.slice(0, 5);
      var customSFValues = datosContacto.slice(5, 5 + extraFieldsSF.length);
      var fromSFCto      = datosContacto.slice(5 + extraFieldsSF.length);

      // Reconstruir el array de valores custom en el ORDEN de extraFields (intercalando SF y Manual)
      var customCombinado = [];
      var sfIdx = 0;
      for (var cfi = 0; cfi < extraFields.length; cfi++) {
        var cf = extraFields[cfi];
        if (cf.mode === "sf") {
          customCombinado.push(customSFValues[sfIdx++]);
        } else {
          // Modo manual: mismo valor para todas las filas
          customCombinado.push(cf.value || "");
        }
      }

      // Mapa: campo → valor traído de SF (solo para los que están en fieldsFromSF)
      var fromSFMap = {};
      for (var fi = 0; fi < fieldsFromSF.length; fi++) {
        fromSFMap[fieldsFromSF[fi]] = fromSFCto[fi];
      }

      // Determinar valor final de cada campo fijo:
      //   1) si está en modo manual → usar el valor manual (idéntico para todas las filas)
      //   2) si está en fromSFMap → usar el valor real del Contact
      //   3) si no → el default hardcodeado
      function valorFijoPara(nombreCampo) {
        if (fieldsManualValues.hasOwnProperty(nombreCampo)) return fieldsManualValues[nombreCampo];
        if (fromSFMap.hasOwnProperty(nombreCampo)) return fromSFMap[nombreCampo];
        return DEFAULTS_HARDCODED[nombreCampo];
      }

      var businessLineFinal = valorFijoPara("BusinessLine__c");
      var leadTypeFinal     = valorFijoPara("Lead_Type__c");
      var segmentFinal      = valorFijoPara("ContactTypeSegment__c");
      var countryFinal      = valorFijoPara("Country__c");
      var rrFinal           = valorFijoPara("Leadassist__Use_Round_Robin__c");
      var statusFinal       = valorFijoPara("Status");
      var facilityFinal     = valorFijoPara("FacilitySize__c");

      // Fila final: [5 base] + [OwnerId] + (BusinessLine si no oculto) + (5 fijos si no ocultos) + (FacilitySize si no oculto) + [N custom combinado]
      // Los campos ocultos no aparecen en la fila
      var filaFinal = baseCto.concat([ownerId]);
      if (!camposFijosOcultos["BusinessLine__c"])              filaFinal.push(businessLineFinal);
      if (!camposFijosOcultos["Lead_Type__c"])                 filaFinal.push(leadTypeFinal);
      if (!camposFijosOcultos["ContactTypeSegment__c"])        filaFinal.push(segmentFinal);
      if (!camposFijosOcultos["Country__c"])                   filaFinal.push(countryFinal);
      if (!camposFijosOcultos["Leadassist__Use_Round_Robin__c"]) filaFinal.push(rrFinal);
      if (!camposFijosOcultos["Status"])                       filaFinal.push(statusFinal);
      if (!camposFijosOcultos["FacilitySize__c"])              filaFinal.push(facilityFinal);
      filaFinal = filaFinal.concat(customCombinado);
      matrizPreTemplate.push(filaFinal);
      assigned++;
    }
    leadsPorOwner[email] = { email: rep.email, ownerId: ownerId, count: assigned, notFound: false };
  });

  var titulos = [
    "Contact__c", "LastSourceAt__c",
    "Company", "LastName", "Email",
    "OwnerId"
  ];
  // Añadir los 7 campos configurables que NO están ocultos
  if (!camposFijosOcultos["BusinessLine__c"])              titulos.push("BusinessLine__c");
  if (!camposFijosOcultos["Lead_Type__c"])                 titulos.push("Lead_Type__c");
  if (!camposFijosOcultos["ContactTypeSegment__c"])        titulos.push("ContactTypeSegment__c");
  if (!camposFijosOcultos["Country__c"])                   titulos.push("Country__c");
  if (!camposFijosOcultos["Leadassist__Use_Round_Robin__c"]) titulos.push("Leadassist__Use_Round_Robin__c");
  if (!camposFijosOcultos["Status"])                       titulos.push("Status");
  if (!camposFijosOcultos["FacilitySize__c"])              titulos.push("FacilitySize__c");
  // Añadir custom fields al FINAL (usando el nombre de cada objeto)
  for (var ef2 = 0; ef2 < extraFields.length; ef2++) titulos.push(extraFields[ef2].name);

  var mensaje = matrizPreTemplate.length > 0
    ? "¡Asignación Completada! Total filas generadas: " + matrizPreTemplate.length
    : "Salesforce no devolvió ningún registro.";
  if (bloquesFallidos > 0) {
    mensaje += " ⚠ OJO: " + bloquesFallidos + " bloque(s) de contactos fallaron en la query y NO entraron al pool. Revisa el log de Apps Script o reintenta." +
               (erroresBloques.length ? " Detalle: " + erroresBloques[0] : "");
  }
  if (idsSinConsultar > 0) {
    mensaje += " ⚠ CORTE POR TIEMPO: " + idsSinConsultar + " ID(s) no alcanzaron a consultarse. Pártelos y vuelve a correr la asignación con ellos.";
  }

  var ownerStats = [];
  reps.forEach(function(rep) {
    var email = rep.email.toString().trim().toLowerCase();
    if (leadsPorOwner[email]) ownerStats.push(leadsPorOwner[email]);
  });

  // Convertir camposFijosOcultos de objeto a array para devolver al frontend
  var camposFijosOcultosArray = Object.keys(camposFijosOcultos);

  return {
    headers: titulos, rows: matrizPreTemplate,
    poolTotal: poolContactos.length, assigned: matrizPreTemplate.length,
    bloquesFallidos: bloquesFallidos,
    erroresBloques: erroresBloques,
    idsSinConsultar: idsSinConsultar,
    idsInvalidos: idsInvalidos,
    idsRepetidos: idsRepetidos,
    repsRepetidos: repsRepetidos,
    mensaje: mensaje, ownerStats: ownerStats,
    ownersNotFound: ownersNotFound,
    leadTypeUsed: leadTypeVal,
    extraFieldsUsados: extraFields,
    extraFieldsRechazados: extraFieldsRechazados,
    fieldsFromSFUsados: fieldsFromSF,
    fieldsManualValuesUsados: fieldsManualValues,
    camposFijosOcultosUsados: camposFijosOcultosArray
  };
}


// ══════════════════════════════════════════════════════════════════════════
//  Helper para serializar valores de campos SF (fechas, números, objetos)
// ══════════════════════════════════════════════════════════════════════════
function serializarValor(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  return String(v);
}


// ══════════════════════════════════════════════════════════════════════════
//  HELPERS DE SEGURIDAD v12.0 — no cambian la lógica de negocio
// ══════════════════════════════════════════════════════════════════════════
// Escapa comillas simples y backslashes antes de interpolar un string en SOQL.
// Evita que un email tipo o'brien@... rompa la query o inyecte condiciones.
function escapeSoql(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
}

// Neutraliza inyección de fórmulas al escribir celdas en Google Sheets:
// si un valor (p.ej. venido de Salesforce) empieza con = + - @ tab o CR,
// se antepone un apóstrofo. Sheets lo trata como texto plano: la celda
// MUESTRA y COPIA el valor original intacto, pero jamás lo ejecuta como fórmula.
function neutralizarValorSheet(v) {
  if (typeof v !== "string" || v === "") return v;
  var c = v.charAt(0);
  if (c === "=" || c === "+" || c === "-" || c === "@" || c === "\t" || c === "\r") return "'" + v;
  return v;
}


// ══════════════════════════════════════════════════════════════════════════
//  v17.0 · IMPORT EN PARALELO — iniciarImportBulk + consultarEstadoJob +
//  recuperarResultadoJob
//
//  POR QUÉ: Bulk API 2.0 procesa un job en transacciones de 200, en serie, y
//  cada Lead cuesta ~1 s por la automatización de Salesforce. Un job de 500
//  tardó 10.5 min (750Tt00000mJwvvIAC). La única forma de paralelizar es crear
//  varios jobs. Se agrupan por OwnerId para que un mismo owner no compita
//  consigo mismo por bloqueos en dos jobs a la vez.
//
//  FLUJO (ninguna petición se acerca al límite de 6 min de Apps Script):
//    · iniciarImportBulk     → crea/sube/cierra N jobs en 3 rondas de fetchAll
//                              y devuelve jobIds[] + loteId
//    · consultarEstadoJob    → suma el estado de todos los jobs (~1 s)
//    · recuperarResultadoJob → baja y une los CSV de todos los jobs; las filas
//                              con UNABLE_TO_LOCK_ROW se reintentan solas una vez
// ══════════════════════════════════════════════════════════════════════════

// Arma el CSV que recibe Bulk API 2.0 (todo entre comillas, LF).
function construirCsv(headers, rows) {
  var q = function(v) {
    if (v === null || v === undefined) v = "";
    return '"' + String(v).replace(/"/g, '""') + '"';
  };
  var lineas = [headers.map(q).join(",")];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i] || [], cells = [];
    for (var j = 0; j < headers.length; j++) cells.push(q(row[j]));
    lineas.push(cells.join(","));
  }
  return lineas.join("\n");
}

// Lee un CSV completo respetando comillas (un salto de línea dentro de un valor
// no parte la fila). Devuelve una matriz; ignora líneas vacías.
function parsearCsv(texto) {
  var filas = [], fila = [], cur = "", enComillas = false;
  var cerrarFila = function() {
    fila.push(cur); cur = "";
    if (fila.length > 1 || fila[0] !== "") filas.push(fila);
    fila = [];
  };
  for (var i = 0; i < texto.length; i++) {
    var c = texto.charAt(i);
    if (enComillas) {
      if (c === '"' && texto.charAt(i + 1) === '"') { cur += '"'; i++; }
      else if (c === '"') enComillas = false;
      else cur += c;
    } else if (c === '"') enComillas = true;
    else if (c === ",") { fila.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto.charAt(i + 1) === "\n") i++;
      cerrarFila();
    } else cur += c;
  }
  if (cur !== "" || fila.length) cerrarFila();
  return filas;
}

// Une varios CSV de resultado con un solo header (todos los jobs traen las mismas columnas).
function unirCsv(lista) {
  var conDatos = lista.filter(function(t) { return t && String(t).trim(); });
  if (!conDatos.length) return "";
  var salida = "";
  conDatos.forEach(function(t, i) {
    t = String(t);
    if (i > 0) {
      var nl = t.indexOf("\n");
      t = nl >= 0 ? t.slice(nl + 1) : "";
    }
    if (t && t.charAt(t.length - 1) !== "\n") t += "\n";
    salida += t;
  });
  return salida;
}

// Hace varias peticiones a la vez y devuelve [{code, text}] en el mismo orden.
function sfFetchAll(peticiones) {
  if (!peticiones.length) return [];
  var reqs = peticiones.map(function(p) {
    var r = { url: p.url, method: p.method || "get", headers: p.headers, muteHttpExceptions: true };
    if (p.payload !== undefined) r.payload = p.payload;
    if (p.contentType) r.contentType = p.contentType;
    return r;
  });
  return UrlFetchApp.fetchAll(reqs).map(function(r) {
    return { code: r.getResponseCode(), text: r.getContentText() };
  });
}

function cabecerasSfJson(sid) {
  return { "Authorization": "Bearer " + sid, "Content-Type": "application/json", "Accept": "application/json" };
}

function ok2xx(code) { return code >= 200 && code < 300; }

// Reparte las filas en jobs. Mismo OwnerId → mismo job. Los owners se acomodan
// del más grande al más chico en el job con menos filas, para que queden parejos.
// Sin columna OwnerId se parte en bloques seguidos.
function repartirEnJobs(headers, rows) {
  var n = rows.length;
  var numJobs = Math.max(1, Math.min(MAX_JOBS_PARALELO, Math.ceil(n / FILAS_POR_JOB)));
  var iOwner = headers.indexOf("OwnerId");

  if (iOwner < 0) {
    var tam = Math.ceil(n / numJobs), partes = [];
    for (var i = 0; i < n; i += tam) partes.push({ rows: rows.slice(i, i + tam) });
    return partes;
  }

  var grupos = [], porOwner = {};
  rows.forEach(function(r) {
    var k = String((r && r[iOwner]) || "").trim().slice(0, 15);
    if (!porOwner.hasOwnProperty(k)) { porOwner[k] = grupos.length; grupos.push({ owner: k, rows: [] }); }
    grupos[porOwner[k]].rows.push(r);
  });
  // Del grupo más grande al más chico (estable: a igual tamaño, el que apareció primero)
  var orden = grupos.map(function(g, i) { return i; })
    .sort(function(a, b) { return (grupos[b].rows.length - grupos[a].rows.length) || (a - b); });
  var bins = [];
  for (var b = 0; b < Math.min(numJobs, grupos.length); b++) bins.push({ rows: [], owners: [] });
  orden.forEach(function(gi) {
    var menor = 0;
    for (var x = 1; x < bins.length; x++) if (bins[x].rows.length < bins[menor].rows.length) menor = x;
    bins[menor].rows = bins[menor].rows.concat(grupos[gi].rows);
    bins[menor].owners.push(grupos[gi].owner);
  });
  return bins.filter(function(bn) { return bn.rows.length > 0; });
}

// Aborta jobs (best effort). Devuelve los que Salesforce aceptó abortar.
function abortarJobs(base, sid, jobIds) {
  var ids = jobIds.filter(Boolean);
  if (!ids.length) return [];
  try {
    var res = sfFetchAll(ids.map(function(id) {
      return { url: base + "/jobs/ingest/" + id, method: "patch", headers: cabecerasSfJson(sid),
               contentType: "application/json", payload: JSON.stringify({ state: "Aborted" }) };
    }));
    return ids.filter(function(id, i) { return ok2xx(res[i].code); });
  } catch (e) {
    Logger.log("[ABORT FAIL] " + e.message);
    return [];
  }
}

function nuevoLoteId() {
  return "lote_" + Utilities.getUuid().replace(/-/g, "").toLowerCase().slice(0, 16);
}

function iniciarImportBulk(params) {
  var sid = params.sid, instanceUrl = params.instanceUrl;
  var object = params.object || "Lead", operation = params.operation || "insert";
  var externalId = params.externalId || "", headers = params.headers, rows = params.rows;
  var userEmail = params.userEmail || "";

  if (!Array.isArray(rows) || !rows.length) throw new Error("No se recibieron filas.");
  if (!Array.isArray(headers) || !headers.length) throw new Error("No se recibieron headers.");
  for (var h = 0; h < headers.length; h++) {
    if (typeof headers[h] !== "string" || !/^[A-Za-z0-9_.:]+$/.test(headers[h])) {
      throw new Error("Header no válido: " + String(headers[h]).slice(0, 60));
    }
  }
  if (!rows.every(function(r) { return Array.isArray(r); })) throw new Error("Filas con formato inválido.");

  // ── Idempotencia: el mismo clientRequestId nunca crea jobs dos veces ──
  // Si la respuesta de un importStart se pierde y el navegador reintenta, se
  // devuelven los jobs que ya existen en vez de crear Leads duplicados.
  var clientRequestId = String(params.clientRequestId || "");
  if (clientRequestId && !/^[A-Za-z0-9_-]{8,64}$/.test(clientRequestId)) throw new Error("clientRequestId no válido.");
  var cache = CacheService.getScriptCache();
  var idemKey = clientRequestId ? "imp_" + hashTexto(userEmail + "|" + clientRequestId) : "";
  if (idemKey) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) throw new Error("El servidor está ocupado. Espera unos segundos y vuelve a intentar.");
    try {
      var previo = cache.get(idemKey);
      if (previo) {
        var p = JSON.parse(previo);
        if (p.estado === "creando") {
          throw new Error("Este import ya se está creando. Espera unos segundos y revisa el log o usa Recuperar.");
        }
        p.repetido = true;
        return p;
      }
      cache.put(idemKey, JSON.stringify({ estado: "creando" }), 600);
    } finally {
      lock.releaseLock();
    }
  }

  try {
    var resultado = crearJobsEnParalelo(sid, instanceUrl, object, operation, externalId, headers, rows, userEmail, clientRequestId);
    if (idemKey) cache.put(idemKey, JSON.stringify(resultado), IMPORT_IDEMP_SEG);
    return resultado;
  } catch (err) {
    if (idemKey) cache.remove(idemKey);  // todo se abortó: un reintento puede crear de nuevo
    throw err;
  }
}

function crearJobsEnParalelo(sid, instanceUrl, object, operation, externalId, headers, rows, userEmail, clientRequestId) {
  var base = instanceUrl + "/services/data/" + SF_API_VERSION;
  // Compatibilidad: el frontend v16 (sin clientRequestId) solo sigue un jobId, así que
  // para él se crea un solo job, como antes. El v17 manda clientRequestId y recibe N jobs.
  var partes = clientRequestId ? repartirEnJobs(headers, rows) : [{ rows: rows }];

  var jobBody = { object: object, operation: operation, contentType: "CSV", lineEnding: "LF" };
  if (operation === "upsert" && externalId) jobBody.externalIdFieldName = externalId;

  // ── RONDA 1: crear los jobs ──
  var r1 = sfFetchAll(partes.map(function() {
    return { url: base + "/jobs/ingest", method: "post", headers: cabecerasSfJson(sid),
             contentType: "application/json", payload: JSON.stringify(jobBody) };
  }));
  var jobIds = [], erroresCrear = [], sesionVencida = false;
  r1.forEach(function(r, i) {
    if (r.code === 401) sesionVencida = true;
    if (ok2xx(r.code)) {
      try { jobIds[i] = JSON.parse(r.text).id; } catch (e) { jobIds[i] = null; }
    }
    if (!jobIds[i]) erroresCrear.push("HTTP " + r.code + ": " + String(r.text).slice(0, 200));
  });
  if (erroresCrear.length) {
    abortarJobs(base, sid, jobIds);
    if (sesionVencida) throw errorSesionSf("al crear el job");
    throw new Error("Error creando Job: " + erroresCrear[0]);
  }

  var loteId = nuevoLoteId();
  // ── AUDITORÍA AL NACER ── aunque todo lo demás falle, los jobIds quedan registrados.
  registrarAuditoria(userEmail, "import", "iniciado",
    "jobId=" + jobIds[0] + "; lote=" + loteId + "; jobIds=" + jobIds.join(",") +
    "; object=" + object + "; op=" + operation + "; rows=" + rows.length +
    (clientRequestId ? "; req=" + clientRequestId : ""));

  var vivos = partes.map(function(p, i) { return i; });   // índices de jobs que siguen en pie
  var motivoCaida = {};
  var marcarCaidos = function(resps, paso) {
    resps.forEach(function(r, k) {
      var i = vivos[k];
      if (r.code === 401) sesionVencida = true;
      if (!ok2xx(r.code)) motivoCaida[i] = paso + " (HTTP " + r.code + "): " + String(r.text).slice(0, 200);
    });
    vivos = vivos.filter(function(i) { return !motivoCaida[i]; });
  };

  try {
    // ── RONDA 2: subir el CSV de cada job ──
    marcarCaidos(sfFetchAll(vivos.map(function(i) {
      return { url: base + "/jobs/ingest/" + jobIds[i] + "/batches", method: "put",
               headers: { "Authorization": "Bearer " + sid, "Content-Type": "text/csv", "Accept": "application/json" },
               contentType: "text/csv", payload: construirCsv(headers, partes[i].rows) };
    })), "Error subiendo CSV");

    // ── RONDA 3: cerrar los jobs (UploadComplete → Salesforce empieza a procesar) ──
    var cerrar = function(indices) {
      return sfFetchAll(indices.map(function(i) {
        return { url: base + "/jobs/ingest/" + jobIds[i], method: "patch", headers: cabecerasSfJson(sid),
                 contentType: "application/json", payload: JSON.stringify({ state: "UploadComplete" }) };
      }));
    };
    var antes = vivos.slice();
    var rc = cerrar(vivos);
    var pendientes = vivos.filter(function(i, k) { return !ok2xx(rc[k].code); });
    if (pendientes.length && !rc.some(function(r) { return r.code === 401; })) {
      // Un segundo intento solo para los que no cerraron
      var rc2 = cerrar(pendientes);
      pendientes = pendientes.filter(function(i, k) {
        if (!ok2xx(rc2[k].code)) { motivoCaida[i] = "Error cerrando Job (HTTP " + rc2[k].code + "): " + String(rc2[k].text).slice(0, 200); return true; }
        return false;
      });
    } else {
      pendientes.forEach(function(i) {
        var k = antes.indexOf(i);
        if (rc[k].code === 401) sesionVencida = true;
        motivoCaida[i] = "Error cerrando Job (HTTP " + rc[k].code + "): " + String(rc[k].text).slice(0, 200);
      });
    }
    vivos = vivos.filter(function(i) { return !motivoCaida[i]; });
  } catch (err) {
    // Excepción de red a mitad: ningún job quedó a medias sin rastro
    partes.forEach(function(p, i) { if (vivos.indexOf(i) !== -1 && !motivoCaida[i]) motivoCaida[i] = "Excepción: " + err.message; });
    vivos = [];
  }

  // Los jobs que no llegaron a cerrar se abortan: sus filas NO se enviaron.
  var caidos = partes.map(function(p, i) { return i; }).filter(function(i) { return vivos.indexOf(i) === -1; });
  if (caidos.length) abortarJobs(base, sid, caidos.map(function(i) { return jobIds[i]; }));

  if (!vivos.length) {
    var primerMotivo = motivoCaida[caidos[0]] || "sin detalle";
    registrarAuditoria(userEmail, "import", "error_al_iniciar",
      "jobId=" + jobIds[0] + "; lote=" + loteId + "; " + String(primerMotivo).slice(0, 250));
    var e = sesionVencida ? errorSesionSf("al subir el import") : new Error(primerMotivo + " (los jobs se abortaron: no se creó ningún registro)");
    e.yaAuditado = true;
    throw e;
  }

  var jobIdsVivos = vivos.map(function(i) { return jobIds[i]; });
  var filasNoEnviadas = [];
  caidos.forEach(function(i) { filasNoEnviadas = filasNoEnviadas.concat(partes[i].rows); });
  if (caidos.length) {
    registrarAuditoria(userEmail, "import", "jobs_abortados",
      "lote=" + loteId + "; jobIds=" + caidos.map(function(i) { return jobIds[i]; }).join(",") +
      "; rows=" + filasNoEnviadas.length + "; " + String(motivoCaida[caidos[0]]).slice(0, 200));
  }

  var resultado = {
    loteId: loteId,
    jobIds: jobIdsVivos,
    jobId: jobIdsVivos[0],                 // compatibilidad con el frontend v16
    jobState: "UploadComplete",
    total: rows.length - filasNoEnviadas.length,
    totalRecibidas: rows.length,
    jobs: vivos.map(function(i) { return { jobId: jobIds[i], filas: partes[i].rows.length }; }),
    object: object,
    operation: operation,
    filasNoEnviadas: filasNoEnviadas,
    errorNoEnviadas: caidos.length ? String(motivoCaida[caidos[0]]) : ""
  };
  try {
    CacheService.getScriptCache().put("lote_" + loteId, JSON.stringify({ jobIds: jobIdsVivos }), IMPORT_IDEMP_SEG);
  } catch (e) {}
  return resultado;
}

// jobIds[] (v17), loteId o jobId suelto (v16). Siempre devuelve una lista válida y sin repetidos.
function resolverJobIds(params) {
  var ids = [];
  if (Array.isArray(params.jobIds) && params.jobIds.length) {
    ids = params.jobIds.map(function(x) { return String(x || "").trim(); });
  } else if (params.loteId) {
    var lote = String(params.loteId).trim();
    if (!LOTE_ID_REGEX.test(lote)) throw new Error("El Lote no tiene un formato válido (ej. lote_1a2b3c4d5e6f7a8b).");
    ids = buscarJobsDeLote(lote);
    if (!ids.length) throw new Error("No encontré los jobs del lote " + lote + ". Usa uno de sus Job ID.");
  } else if (params.jobId) {
    ids = [String(params.jobId).trim()];
  }
  if (!ids.length) throw new Error("No se recibió un Job ID.");
  var vistos = {}, limpios = [];
  ids.forEach(function(id) {
    if (!JOB_ID_REGEX.test(id)) throw new Error("El Job ID no tiene un formato válido. Debe empezar con '750' (ej. 750Tt00000gk1XBIAY).");
    if (!vistos[id]) { vistos[id] = true; limpios.push(id); }
  });
  if (limpios.length > MAX_JOBS_PARALELO * 2) throw new Error("Demasiados Job IDs en una consulta.");
  return limpios;
}

// Los jobs de un lote: primero el caché (6 h), si no, la fila "iniciado" de la auditoría.
function buscarJobsDeLote(loteId) {
  try {
    var c = CacheService.getScriptCache().get("lote_" + loteId);
    if (c) return JSON.parse(c).jobIds || [];
  } catch (e) {}
  if (!AUDIT_SHEET_ID) return [];
  try {
    var sh = SpreadsheetApp.openById(AUDIT_SHEET_ID).getSheets()[0];
    var last = sh.getLastRow();
    if (last < 2) return [];
    var desde = Math.max(2, last - 5000);
    var vals = sh.getRange(desde, 5, last - desde + 1, 1).getValues();
    for (var i = vals.length - 1; i >= 0; i--) {
      var det = String(vals[i][0] || "");
      if (det.indexOf("lote=" + loteId + ";") === -1) continue;
      var m = det.match(/jobIds=([0-9A-Za-z,]+)/);
      if (m) return m[1].split(",").filter(function(x) { return JOB_ID_REGEX.test(x); });
    }
  } catch (e) {
    Logger.log("[LOTE] " + e.message);
  }
  return [];
}

var ESTADOS_FINALES = { JobComplete: 1, Failed: 1, Aborted: 1 };
// Estados de auditoría que cierran un import (para no listarlo como huérfano)
var ESTADOS_CIERRE_AUDIT = { success: 1, error: 1, job_failed: 1, error_resultados: 1, error_al_iniciar: 1 };

// ══════════════════════════════════════════════════════════════════════════
//  CONSULTA LIGERA DE ESTADO — la repite el frontend cada 5-15 s.
//  Solo pregunta el estado de los jobs (fetchAll): NO descarga los CSV.
//  Suma procesados y fallidos de todos para la barra de progreso, y devuelve
//  retries / apexProcessingTime / totalProcessingTime para diagnóstico.
// ══════════════════════════════════════════════════════════════════════════
function consultarEstadoJob(params) {
  var sid = params.sid, instanceUrl = params.instanceUrl;
  var ids = resolverJobIds(params);
  var base = instanceUrl + "/services/data/" + SF_API_VERSION;

  var res = sfFetchAll(ids.map(function(id) {
    return { url: base + "/jobs/ingest/" + id, method: "get",
             headers: { "Authorization": "Bearer " + sid, "Accept": "application/json" } };
  }));

  var jobs = [], processed = 0, failed = 0, retries = 0, apex = 0, totalMs = 0, errores = [];
  var object = "", operation = "", externalIdFieldName = "", createdDate = "";
  res.forEach(function(r, i) {
    if (r.code === 401) throw errorSesionSf("al consultar el job");
    if (r.code === 404) throw new Error("No se encontró el Job " + ids[i] + ". Salesforce conserva los jobs ~7 días.");
    if (r.code !== 200) throw new Error("Salesforce devolvió HTTP " + r.code + " al consultar el Job " + ids[i] + ".");
    var d = JSON.parse(r.text);
    var state = d.state || "Unknown";
    processed += d.numberRecordsProcessed || 0;
    failed += d.numberRecordsFailed || 0;
    retries += d.retries || 0;
    apex += d.apexProcessingTime || 0;
    totalMs += d.totalProcessingTime || 0;
    if (!object) { object = d.object || ""; operation = d.operation || ""; externalIdFieldName = d.externalIdFieldName || ""; }
    if (!createdDate || (d.createdDate && d.createdDate < createdDate)) createdDate = d.createdDate || createdDate;
    if ((state === "Failed" || state === "Aborted")) errores.push(ids[i] + ": " + (d.errorMessage || "Sin mensaje de error"));
    jobs.push({ jobId: ids[i], state: state, processed: d.numberRecordsProcessed || 0, failed: d.numberRecordsFailed || 0 });
  });

  var terminado = jobs.every(function(j) { return ESTADOS_FINALES[j.state]; });
  var jobState;
  if (!terminado) jobState = jobs.some(function(j) { return j.state === "InProgress"; }) ? "InProgress" : jobs[0].state;
  else if (jobs.every(function(j) { return j.state === "JobComplete"; })) jobState = "JobComplete";
  else if (jobs.some(function(j) { return j.state === "Failed"; })) jobState = "Failed";
  else jobState = "Aborted";

  return {
    jobId: ids[0],
    jobIds: ids,
    loteId: params.loteId || "",
    jobState: jobState,
    jobs: jobs,
    processed: processed,
    failed: failed,
    terminado: terminado,
    retries: retries,
    apexProcessingTime: apex,
    totalProcessingTime: totalMs,
    errorMessage: errores.join(" | "),
    object: object,
    operation: operation,
    externalIdFieldName: externalIdFieldName,
    createdDate: createdDate
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  RESULTADOS — baja successful/failed/unprocessed de todos los jobs a la vez
//  y los une con un solo header. Si una descarga falla, lo dice (resultsError):
//  antes se devolvía un "éxito vacío".
// ══════════════════════════════════════════════════════════════════════════
function recuperarResultadoJob(params) {
  var sid = params.sid, instanceUrl = params.instanceUrl;
  var ids = resolverJobIds(params);
  var base = instanceUrl + "/services/data/" + SF_API_VERSION;

  // Si estos jobs ya tuvieron su reintento por bloqueo, sus filas se resolvieron en
  // otro job. En una recuperación manual se juntan aquí: si no, esas filas saldrían
  // como fallidas y un Retry las crearía dos veces.
  var jobLock = (params.reintentarLock === true) ? "" : buscarReintentoLock(ids);
  var todos = jobLock && ids.indexOf(jobLock) === -1 ? ids.concat([jobLock]) : ids;
  var est = consultarEstadoJob({ sid: sid, instanceUrl: instanceUrl, jobIds: todos, loteId: params.loteId || "" });

  var salida = est;
  salida.successCsv = ""; salida.failedCsv = ""; salida.unprocessedCsv = "";
  salida.resultsError = ""; salida.reintentoLock = null;
  salida.incluyeReintentoLock = !!(jobLock && todos.length > ids.length);
  salida.stillProcessing = !est.terminado;
  if (salida.stillProcessing) return salida;

  var TIPOS = ["successfulResults", "failedResults", "unprocessedrecords"];
  var peticiones = [];
  todos.forEach(function(id) {
    TIPOS.forEach(function(t) {
      peticiones.push({ url: base + "/jobs/ingest/" + id + "/" + t, method: "get",
                        headers: { "Authorization": "Bearer " + sid, "Accept": "text/csv" } });
    });
  });
  var res = sfFetchAll(peticiones);
  var partes = [[], [], []], partesLock = [[], [], []], errores = [];
  res.forEach(function(r, k) {
    var id = todos[Math.floor(k / 3)], t = k % 3;
    if (r.code === 401) throw errorSesionSf("al descargar los resultados");
    if (r.code !== 200) errores.push(id + " " + TIPOS[t] + ": HTTP " + r.code);
    else if (salida.incluyeReintentoLock && id === jobLock) partesLock[t].push(r.text);
    else partes[t].push(r.text);
  });
  var fallidasPrincipales = unirCsv(partes[1]);
  if (salida.incluyeReintentoLock) fallidasPrincipales = separarFilasLock(fallidasPrincipales).restoCsv;
  salida.successCsv = unirCsv(partes[0].concat(partesLock[0]));
  salida.failedCsv = unirCsv([fallidasPrincipales].concat(partesLock[1]));
  salida.unprocessedCsv = unirCsv(partes[2].concat(partesLock[2]));
  if (errores.length) {
    salida.resultsError = "No se pudieron descargar todos los resultados (" + errores.join("; ") +
      "). Los registros sí se procesaron en Salesforce: vuelve a intentar con Recuperar.";
  }

  // ── Reintento por bloqueo: solo en el cierre automático, una sola vez ──
  if (params.reintentarLock === true && !salida.resultsError && salida.failedCsv) {
    var lock = separarFilasLock(salida.failedCsv);
    if (lock.rows.length) {
      var r = lanzarReintentoLock(sid, instanceUrl, est, ids, lock, params.userEmail || "", params.loteId || "");
      if (r.jobId) {
        salida.failedCsv = lock.restoCsv;
        salida.reintentoLock = { jobId: r.jobId, filas: lock.rows.length };
      } else {
        salida.reintentoLockError = r.error;
      }
    }
  }
  return salida;
}

// El job de reintento por bloqueo de estos jobs, si existe: caché (6 h) o la fila
// "reintentoLock · iniciado" de la auditoría (de=<jobIds originales>).
function buscarReintentoLock(ids) {
  var ordenados = ids.slice().sort().join(",");
  try {
    var c = CacheService.getScriptCache().get("lock_" + hashTexto(ordenados));
    if (c) return c;
  } catch (e) {}
  if (!AUDIT_SHEET_ID) return "";
  try {
    var sh = SpreadsheetApp.openById(AUDIT_SHEET_ID).getSheets()[0];
    var last = sh.getLastRow();
    if (last < 2) return "";
    var desde = Math.max(2, last - 5000);
    var vals = sh.getRange(desde, 3, last - desde + 1, 3).getValues();   // Operación, Estado, Detalles
    for (var i = vals.length - 1; i >= 0; i--) {
      if (String(vals[i][0]) !== "reintentoLock" || String(vals[i][1]) !== "iniciado") continue;
      var det = String(vals[i][2] || "");
      var de = det.match(/de=([0-9A-Za-z,]+)/), jm = det.match(/jobId=(750[a-zA-Z0-9]+)/);
      if (de && jm && de[1].split(",").sort().join(",") === ordenados) return jm[1];
    }
  } catch (e) {
    Logger.log("[LOCK LOOKUP] " + e.message);
  }
  return "";
}

// Separa las filas fallidas por UNABLE_TO_LOCK_ROW. Devuelve sus columnas
// originales (sin sf__Id ni sf__Error) y el CSV de fallidas sin ellas.
function separarFilasLock(failedCsv) {
  var m = parsearCsv(failedCsv);
  if (m.length < 2) return { headers: [], rows: [], restoCsv: failedCsv };
  var hdr = m[0], iErr = hdr.indexOf("sf__Error");
  var quitar = {};
  hdr.forEach(function(h, i) { if (h === "sf__Id" || h === "sf__Error") quitar[i] = true; });
  var headersOrig = hdr.filter(function(h, i) { return !quitar[i]; });
  var conLock = [], resto = [];
  for (var i = 1; i < m.length; i++) {
    var esLock = iErr >= 0 && String(m[i][iErr] || "").indexOf(ERROR_LOCK) === 0;
    if (esLock) conLock.push(m[i].filter(function(v, j) { return !quitar[j]; }));
    else resto.push(m[i]);
  }
  var q = function(v) { return '"' + String(v === undefined ? "" : v).replace(/"/g, '""') + '"'; };
  var restoCsv = resto.length ? [hdr.map(q).join(",")].concat(resto.map(function(r) { return r.map(q).join(","); })).join("\n") + "\n" : "";
  return { headers: headersOrig, rows: conLock, restoCsv: restoCsv };
}

// Un solo job extra con las filas bloqueadas. Idempotente: si ya se lanzó para
// estos jobs, devuelve el mismo jobId (nunca se reintentan dos veces).
function lanzarReintentoLock(sid, instanceUrl, est, ids, lock, userEmail, loteId) {
  var cache = CacheService.getScriptCache();
  var key = "lock_" + hashTexto(ids.slice().sort().join(","));
  var previo = cache.get(key);
  if (previo) return { jobId: previo };

  var base = instanceUrl + "/services/data/" + SF_API_VERSION;
  var operation = OPERACIONES_IMPORT.indexOf(est.operation) !== -1 ? est.operation : "insert";
  var jobBody = { object: est.object || "Lead", operation: operation, contentType: "CSV", lineEnding: "LF" };
  if (operation === "upsert" && est.externalIdFieldName) jobBody.externalIdFieldName = est.externalIdFieldName;
  var jobId = null;
  try {
    var rc = UrlFetchApp.fetch(base + "/jobs/ingest", { method: "post", headers: cabecerasSfJson(sid), contentType: "application/json",
      payload: JSON.stringify(jobBody), muteHttpExceptions: true });
    if (!ok2xx(rc.getResponseCode())) return { error: "No se pudo crear el job de reintento (HTTP " + rc.getResponseCode() + ")." };
    jobId = JSON.parse(rc.getContentText()).id;
    var ru = UrlFetchApp.fetch(base + "/jobs/ingest/" + jobId + "/batches", { method: "put",
      headers: { "Authorization": "Bearer " + sid, "Content-Type": "text/csv", "Accept": "application/json" },
      contentType: "text/csv", payload: construirCsv(lock.headers, lock.rows), muteHttpExceptions: true });
    if (!ok2xx(ru.getResponseCode())) throw new Error("subida HTTP " + ru.getResponseCode());
    var rz = UrlFetchApp.fetch(base + "/jobs/ingest/" + jobId, { method: "patch", headers: cabecerasSfJson(sid), contentType: "application/json",
      payload: JSON.stringify({ state: "UploadComplete" }), muteHttpExceptions: true });
    if (!ok2xx(rz.getResponseCode())) throw new Error("cierre HTTP " + rz.getResponseCode());
  } catch (e) {
    if (jobId) abortarJobs(base, sid, [jobId]);
    return { error: "No se pudo lanzar el reintento por bloqueo: " + e.message };
  }
  cache.put(key, jobId, IMPORT_IDEMP_SEG);
  registrarAuditoria(userEmail, "reintentoLock", "iniciado",
    "jobId=" + jobId + (loteId ? "; lote=" + loteId : "") + "; de=" + ids.join(",") + "; rows=" + lock.rows.length);
  return { jobId: jobId };
}

// Auditoría con el estado REAL (v17; antes siempre "success").
function estadoAuditoriaRecuperar(r) {
  if (!r) return "error";
  if (r.stillProcessing) return "en_proceso";
  if (r.resultsError) return "error_resultados";
  return r.jobState === "JobComplete" ? "success" : "job_failed";
}

function detalleAuditoriaJobs(r) {
  r = r || {};
  var ids = r.jobIds || (r.jobId ? [r.jobId] : []);
  return "jobId=" + (ids[0] || "N/A") +
    (r.loteId ? "; lote=" + r.loteId : "") +
    (ids.length > 1 ? "; jobIds=" + ids.join(",") : "") +
    "; state=" + (r.jobState || "N/A") +
    "; processed=" + (r.processed || 0) + "; failed=" + (r.failed || 0) +
    "; retries=" + (r.retries || 0) + "; apexMs=" + (r.apexProcessingTime || 0) +
    "; totalMs=" + (r.totalProcessingTime || 0) +
    (r.reintentoLock ? "; lockRetry=" + r.reintentoLock.jobId + "(" + r.reintentoLock.filas + ")" : "");
}

function exportarResultadoASheet(params) {
  var userEmail       = (params.userEmail || "").trim().toLowerCase();
  var fileName        = (params.fileName || "SF Asignador Export").trim();
  var targetSheetUrl  = (params.targetSheetUrl || "").trim();
  var folderIdRaw     = (params.folderId || "").trim();
  // Flags para modo attached: si el usuario quiere mover/renombrar el sheet existente
  var moverAttached   = params.moverAttached === true;   // mover a carpeta el sheet existente
  var renombrarAttached = (params.renombrarAttached || "").trim();  // nuevo nombre (vacío = mantener)
  // Aceptar link completo de carpeta o solo el ID
  var folderId = folderIdRaw ? extraerIdDeCarpeta(folderIdRaw) : DEFAULT_DRIVE_FOLDER_ID;
  if (!folderId) folderId = DEFAULT_DRIVE_FOLDER_ID;  // fallback si el link no se parseó

  var summary             = params.summary || {};
  var preTemplateHeaders  = params.preTemplateHeaders  || [];
  var preTemplateRows     = params.preTemplateRows     || [];
  var importResultHeaders = params.importResultHeaders || [];
  var importResultRows    = params.importResultRows    || [];

  if (!summary.meta) summary.meta = {};
  summary.meta.ejecutadoPor = userEmail || "(desconocido)";

  var ss;
  var mode;

  if (targetSheetUrl) {
    var idFromUrl = extraerIdDeUrl(targetSheetUrl);
    if (!idFromUrl) throw new Error("URL del Sheet inválida. Pega un link tipo: https://docs.google.com/spreadsheets/d/…");
    // v17: la cuenta del script ve archivos que el usuario no. Solo se adjunta a un
    // Sheet del usuario (dueño o editor), y nunca al de auditoría.
    if (idFromUrl === AUDIT_SHEET_ID) throw new Error("Ese Sheet no se puede usar como destino.");
    var archivoDestino;
    try { archivoDestino = DriveApp.getFileById(idFromUrl); } catch (e) { archivoDestino = null; }
    if (!archivoDestino || !usuarioPuedeEditar(archivoDestino, userEmail)) {
      throw new Error("Solo puedes adjuntar a un Sheet tuyo o donde seas editor. " +
                      "Compártelo contigo como Editor (y con la cuenta del script) y vuelve a intentar.");
    }

    try {
      ss = SpreadsheetApp.openById(idFromUrl);
    } catch (e) {
      throw new Error(
        "No se pudo abrir el Sheet. Debes compartirlo con la cuenta que desplegó el script " +
        "(dale acceso de Editor a esa cuenta). El link era: " + targetSheetUrl
      );
    }
    mode = "attached";
  } else {
    try {
      ss = SpreadsheetApp.create(fileName);
    } catch (e) {
      throw new Error(
        "No se pudo crear el Sheet. El deployer del Apps Script debe autorizar los permisos " +
        "de Sheets y Drive. Detalle: " + e.message
      );
    }
    mode = "created";
  }

  // v17: si algo falla a la mitad, el Sheet recién creado se manda a la papelera
  // (antes quedaba huérfano en Drive).
  try {
    llenarTresHojas(ss, summary, preTemplateHeaders, preTemplateRows, importResultHeaders, importResultRows);
  } catch (e) {
    if (mode === "created") { try { DriveApp.getFileById(ss.getId()).setTrashed(true); } catch (e2) {} }
    throw e;
  }

  if (mode === "created") {
    var sheets = ss.getSheets();
    for (var i = 0; i < sheets.length; i++) {
      var name = sheets[i].getName();
      if (name === "Hoja 1" || name === "Sheet1") {
        try { ss.deleteSheet(sheets[i]); } catch (e) {}
      }
    }
  }

  var fileId = ss.getId();
  var ownershipTransferred = false, ownershipError = "";
  var folderMoved = false, folderMoveError = "", folderMovedTo = "";
  var renamed = false, renameError = "", renamedTo = "";

  if (mode === "created") {
    var file = DriveApp.getFileById(fileId);

    // Mover a carpeta (usando moveTo, más moderno que addFile/removeFile)
    if (folderId) {
      try {
        var folder = DriveApp.getFolderById(folderId);
        folderMovedTo = folder.getName();  // valida que la carpeta existe y hay acceso
        file.moveTo(folder);
        folderMoved = true;
        Logger.log("[FOLDER MOVE OK] " + fileId + " → " + folder.getName() + " (" + folderId + ")");
      } catch (e) {
        folderMoveError = e.message;
        Logger.log("[FOLDER MOVE FAIL] " + folderId + ": " + e.message);
      }
    }

    // Transferir ownership al usuario final
    if (userEmail && userEmail.indexOf("@") > 0) {
      try {
        file.setOwner(userEmail);
        ownershipTransferred = true;
      } catch (e) {
        ownershipError = e.message;
        Logger.log("[OWNERSHIP FAIL] " + userEmail + ": " + e.message);
      }
    }
  } else if (mode === "attached") {
    // En modo attached: opcionalmente mover a carpeta y/o renombrar el sheet EXISTENTE
    var fileAttached = null;
    try { fileAttached = DriveApp.getFileById(fileId); } catch (e) { fileAttached = null; }

    // Renombrar (si el usuario dio un nombre nuevo)
    if (renombrarAttached && fileAttached) {
      try {
        fileAttached.setName(renombrarAttached);
        renamed = true;
        renamedTo = renombrarAttached;
        Logger.log("[RENAME OK] " + fileId + " → " + renombrarAttached);
      } catch (e) {
        renameError = e.message;
        Logger.log("[RENAME FAIL] " + fileId + ": " + e.message);
      }
    }

    // Mover a carpeta (solo si el usuario activó el flag)
    if (moverAttached && fileAttached) {
      try {
        var folderA = DriveApp.getFolderById(folderId);
        folderMovedTo = folderA.getName();
        fileAttached.moveTo(folderA);
        folderMoved = true;
        Logger.log("[FOLDER MOVE OK attached] " + fileId + " → " + folderA.getName() + " (" + folderId + ")");
      } catch (e) {
        folderMoveError = e.message;
        Logger.log("[FOLDER MOVE FAIL attached] " + folderId + ": " + e.message);
      }
    }
  }

  return {
    url: ss.getUrl(), id: fileId, name: ss.getName(),
    mode: mode,
    ownershipTransferred: ownershipTransferred,
    ownershipError: ownershipError,
    folderMoved: folderMoved,
    folderMoveError: folderMoveError,
    folderMovedTo: folderMovedTo,
    folderIdUsed: folderId,
    renamed: renamed,
    renameError: renameError,
    renamedTo: renamedTo,
    executedBy: userEmail
  };
}


// ══════════════════════════════════════════════════════════════════════════
//  EXPORT SHEET DESDE ARCHIVO (CSV o Excel subido desde el frontend)
//  Payload: además de los datos normales, incluye fileContent (base64) y fileName (con extensión)
// ══════════════════════════════════════════════════════════════════════════
function exportarSheetDesdeArchivo(params) {
  var userEmail    = (params.userEmail || "").trim().toLowerCase();
  var fileName     = (params.fileName || "SF Asignador Export").trim();
  var folderIdRaw  = (params.folderId || "").trim();
  var folderId     = folderIdRaw ? extraerIdDeCarpeta(folderIdRaw) : DEFAULT_DRIVE_FOLDER_ID;
  if (!folderId) folderId = DEFAULT_DRIVE_FOLDER_ID;
  var fileContent  = params.fileContent || "";      // base64
  var fileMimeType = params.fileMimeType || "";      // ej. text/csv o application/vnd.openxmlformats-...
  var origFileName = params.origFileName || "uploaded";

  if (!fileContent) throw new Error("No se recibió contenido de archivo.");

  var summary             = params.summary || {};
  var preTemplateHeaders  = params.preTemplateHeaders  || [];
  var preTemplateRows     = params.preTemplateRows     || [];
  var importResultHeaders = params.importResultHeaders || [];
  var importResultRows    = params.importResultRows    || [];

  if (!summary.meta) summary.meta = {};
  summary.meta.ejecutadoPor = userEmail || "(desconocido)";

  // Decodificar base64 a bytes
  var bytes = Utilities.base64Decode(fileContent);
  var blob = Utilities.newBlob(bytes, fileMimeType, origFileName);

  // Subir a Drive, convirtiéndolo a Google Sheet
  // Para conversión, usamos DriveApp con conversión explícita via Advanced Drive Service.
  // Como alternativa simple sin Advanced Service: creamos el archivo y luego usamos DriveApp
  // para convertirlo. Aquí una técnica que funciona sin habilitar Advanced Services:
  var newFile;
  try {
    // Sube el blob y déjalo en Drive (no convertido)
    newFile = DriveApp.createFile(blob);
    newFile.setName(fileName);
  } catch (e) {
    throw new Error("No se pudo subir el archivo: " + e.message);
  }

  // Ahora abrimos como Spreadsheet — Google convierte automáticamente los CSV/XLSX
  // al hacer SpreadsheetApp.openById si el archivo es compatible, PERO solo funciona
  // si está convertido a Sheet. Usamos Advanced Drive API vía UrlFetchApp para forzar la conversión:
  var accessToken = ScriptApp.getOAuthToken();
  var uploadedFileId = newFile.getId();

  // Crear un Sheet nuevo y luego copiar los datos del archivo subido
  // Estrategia más simple: leer el archivo original con SpreadsheetApp si es Sheet nativo,
  // o parsear el CSV directamente si es CSV.
  var ss;
  var origContent = "";

  if (fileMimeType.indexOf("csv") >= 0 || origFileName.toLowerCase().endsWith(".csv")) {
    // Es CSV: parseamos manualmente
    // v17: try/finally para no dejar el archivo temporal ni un Sheet a medias en Drive
    try {
      origContent = blob.getDataAsString();
      ss = SpreadsheetApp.create(fileName);
      var receivedSheet = anadirHoja(ss, "Received Data");
      // borrar hoja default
      var defaultSheet = ss.getSheetByName("Hoja 1") || ss.getSheetByName("Sheet1");
      if (defaultSheet) try { ss.deleteSheet(defaultSheet); } catch(e) {}

      var csvData = Utilities.parseCsv(origContent);
      if (csvData.length > 0) {
        var maxCols = 0;
        csvData.forEach(function(r) { if (r.length > maxCols) maxCols = r.length; });
        // Normalizar filas al mismo número de columnas.
        // v17: neutralizar fórmulas también aquí (el archivo viene del usuario).
        var normalized = csvData.map(function(r) {
          while (r.length < maxCols) r.push("");
          return r.map(neutralizarValorSheet);
        });
        receivedSheet.getRange(1, 1, normalized.length, maxCols).setValues(normalized);
        receivedSheet.setFrozenRows(1);
      }
    } catch (e) {
      if (ss) { try { DriveApp.getFileById(ss.getId()).setTrashed(true); } catch (e2) {} }
      throw new Error("No se pudo leer el CSV. " + e.message);
    } finally {
      // Borrar el archivo temporal subido
      try { DriveApp.getFileById(uploadedFileId).setTrashed(true); } catch(e) {}
    }
  } else {
    // Es XLSX: convertimos usando Drive API v3
    try {
      var convertUrl = "https://www.googleapis.com/drive/v3/files/" + uploadedFileId + "/copy";
      var convertRes = UrlFetchApp.fetch(convertUrl, {
        method: "post",
        headers: { "Authorization": "Bearer " + accessToken, "Content-Type": "application/json" },
        payload: JSON.stringify({
          name: fileName,
          mimeType: "application/vnd.google-apps.spreadsheet"
        }),
        muteHttpExceptions: true
      });
      if (convertRes.getResponseCode() >= 300) {
        throw new Error("Error convirtiendo XLSX: " + convertRes.getContentText().slice(0, 300));
      }
      var convertedId = JSON.parse(convertRes.getContentText()).id;
      // Borrar el XLSX original
      try { DriveApp.getFileById(uploadedFileId).setTrashed(true); } catch(e) {}
      ss = SpreadsheetApp.openById(convertedId);
    } catch (e) {
      // Cleanup del archivo subido
      try { DriveApp.getFileById(uploadedFileId).setTrashed(true); } catch(err) {}
      throw new Error("No se pudo convertir el Excel. " + e.message);
    }
  }

  // Añadir las 3 hojas nuevas (si falla, el Sheet nuevo va a la papelera)
  try {
    llenarTresHojas(ss, summary, preTemplateHeaders, preTemplateRows, importResultHeaders, importResultRows);
  } catch (e) {
    try { DriveApp.getFileById(ss.getId()).setTrashed(true); } catch (e2) {}
    throw e;
  }

  var fileId = ss.getId();
  var file = DriveApp.getFileById(fileId);
  var folderMoved = false, folderMoveError = "", folderMovedTo = "";

  // Mover a carpeta con moveTo() moderno
  if (folderId) {
    try {
      var folder = DriveApp.getFolderById(folderId);
      folderMovedTo = folder.getName();
      file.moveTo(folder);
      folderMoved = true;
      Logger.log("[FOLDER MOVE OK] " + fileId + " → " + folder.getName() + " (" + folderId + ")");
    } catch (e) {
      folderMoveError = e.message;
      Logger.log("[FOLDER MOVE FAIL] " + folderId + ": " + e.message);
    }
  }

  var ownershipTransferred = false, ownershipError = "";
  if (userEmail && userEmail.indexOf("@") > 0) {
    try {
      file.setOwner(userEmail);
      ownershipTransferred = true;
    } catch (e) {
      ownershipError = e.message;
    }
  }

  return {
    url: ss.getUrl(), id: fileId, name: ss.getName(),
    mode: "created_from_file",
    ownershipTransferred: ownershipTransferred,
    ownershipError: ownershipError,
    folderMoved: folderMoved,
    folderMoveError: folderMoveError,
    folderMovedTo: folderMovedTo,
    folderIdUsed: folderId,
    executedBy: userEmail
  };
}


// ══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════════
function anadirHoja(ss, baseName) {
  var name = baseName, suffix = 2;
  while (ss.getSheetByName(name) !== null) { name = baseName + " " + suffix; suffix++; }
  return ss.insertSheet(name);
}

function llenarTresHojas(ss, summary, preTemplateHeaders, preTemplateRows, importResultHeaders, importResultRows) {
  var summarySheet      = anadirHoja(ss, "Summary");
  var preTemplateSheet  = anadirHoja(ss, "Pre Template");
  var importResultSheet = anadirHoja(ss, "Import Result");

  llenarSummarySheet(summarySheet, summary);
  if (preTemplateHeaders.length && preTemplateRows.length) llenarHojaConDatos(preTemplateSheet, preTemplateHeaders, preTemplateRows);
  else preTemplateSheet.getRange(1,1).setValue("Sin datos de Pre Template.");
  if (importResultHeaders.length && importResultRows.length) llenarHojaConDatos(importResultSheet, importResultHeaders, importResultRows);
  else importResultSheet.getRange(1,1).setValue("Sin resultado de import.");
}

// v17: el usuario (no la cuenta del script) debe ser dueño o editor del archivo.
function usuarioPuedeEditar(archivo, userEmail) {
  var em = String(userEmail || "").toLowerCase();
  if (!em) return false;
  try {
    var owner = archivo.getOwner();
    if (owner && String(owner.getEmail()).toLowerCase() === em) return true;
  } catch (e) {}
  try {
    return archivo.getEditors().some(function(u) { return String(u.getEmail()).toLowerCase() === em; });
  } catch (e) {
    return false;
  }
}

function llenarHojaConDatos(sheet, headers, rows) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers.map(neutralizarValorSheet)]);
  sheet.getRange(1, 1, 1, headers.length).setBackground("#1e2235").setFontColor("#ffffff").setFontWeight("bold");
  if (rows.length > 0) {
    var normalizedRows = rows.map(function(r) {
      var arr = [];
      // v12.0: neutralizarValorSheet evita que un valor venido de SF se ejecute como fórmula
      for (var i = 0; i < headers.length; i++) arr.push(neutralizarValorSheet(r[i] !== undefined && r[i] !== null ? r[i] : ""));
      return arr;
    });
    sheet.getRange(2, 1, normalizedRows.length, headers.length).setValues(normalizedRows);
  }
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}

// v17: arma toda la hoja en una matriz y la escribe con UN setValues
// (antes eran ~20 setValue sueltos, cada uno es una llamada al servicio).
function llenarSummarySheet(sheet, summary) {
  var ownerStats = summary.ownerStats || [];
  var meta       = summary.meta       || {};
  var ANCHO = 6;
  var m = [];
  var fila = function(vals) { var f = vals.slice(); while (f.length < ANCHO) f.push(""); m.push(f); return m.length; };

  fila(["Resumen de Asignación e Import"]);
  fila([]);
  var filaEjecutadoPor = 0;
  if (meta.fecha)        fila(["Fecha:", neutralizarValorSheet(String(meta.fecha))]);
  if (meta.ejecutadoPor) filaEjecutadoPor = fila(["Ejecutado por:", neutralizarValorSheet(String(meta.ejecutadoPor))]);
  if (meta.businessLine) fila(["Business Line:", neutralizarValorSheet(String(meta.businessLine))]);
  if (meta.dias !== undefined && meta.dias !== null && meta.dias !== "") {
    fila(["Días exclusión:", meta.dias === 0 ? "Sin filtro" : neutralizarValorSheet(String(meta.dias))]);
  }
  fila([]);
  var startRow = fila(["Owner (email)", "Leads asignados", "", "Contactos asignados", "Representantes activos", "Contactos que pasaron el query"]);
  var primeraOwner = startRow + 1;
  var totales = [Number(summary.contactosAsignados) || 0, Number(summary.repsActivos) || 0, Number(summary.contactosQueryPass) || 0];
  if (ownerStats.length > 0) {
    ownerStats.forEach(function(o, i) {
      var f = [neutralizarValorSheet(String(o.email || "")), Number(o.count) || 0, ""];
      fila(i === 0 ? f.concat(totales) : f);
    });
    fila(["TOTAL", "=SUM(B" + primeraOwner + ":B" + (primeraOwner + ownerStats.length - 1) + ")"]);
  } else {
    fila(["", "", ""].concat(totales));
  }

  sheet.getRange(1, 1, m.length, ANCHO).setValues(m);
  sheet.getRange(1, 1).setFontSize(14).setFontWeight("bold").setFontColor("#4b7cf3");
  if (filaEjecutadoPor) sheet.getRange(filaEjecutadoPor, 2).setFontWeight("bold");
  sheet.getRange(startRow, 1, 1, 2).setFontWeight("bold").setBackground("#1e2235").setFontColor("#ffffff");
  sheet.getRange(startRow, 4, 1, 3).setFontWeight("bold").setBackground("#1e2235").setFontColor("#ffffff");
  if (ownerStats.length > 0) sheet.getRange(m.length, 1, 1, 2).setFontWeight("bold").setBackground("#f0f0f0");

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, ANCHO);
}

function extraerIdDeUrl(url) {
  var match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (match && match[1]) return match[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(url)) return url;
  return null;
}

function extraerIdDeCarpeta(input) {
  if (!input) return null;
  input = String(input).trim();
  // Formato: https://drive.google.com/drive/folders/ID  (con o sin query params)
  var match = input.match(/\/folders\/([a-zA-Z0-9-_]+)/);
  if (match && match[1]) return match[1];
  // También aceptar el formato de "open?id=ID"
  var match2 = input.match(/[?&]id=([a-zA-Z0-9-_]+)/);
  if (match2 && match2[1]) return match2[1];
  // Si el usuario pegó solo el ID sin URL
  if (/^[a-zA-Z0-9-_]{20,}$/.test(input)) return input;
  return null;
}


// ══════════════════════════════════════════════════════════════════════════
//  TEST DE CARPETA COE — Ejecuta esta función manualmente desde el editor
//  para verificar que la carpeta hardcodeada exista y sea accesible.
//
//  Cómo usar:
//    1. En el editor de Apps Script, selecciona esta función en el dropdown
//    2. Presiona Ejecutar (▶)
//    3. Revisa los logs (menú Ejecución → Ver logs, o Ctrl+Enter)
// ══════════════════════════════════════════════════════════════════════════
function testCarpetaCOE() {
  Logger.log("═══════════════════════════════════════════════");
  Logger.log("  TEST DE CARPETA COE — SF ASIGNADOR");
  Logger.log("═══════════════════════════════════════════════");
  Logger.log("DEFAULT_DRIVE_FOLDER_ID: " + DEFAULT_DRIVE_FOLDER_ID);
  Logger.log("Cuenta actual del script: " + Session.getEffectiveUser().getEmail());
  Logger.log("");

  try {
    Logger.log("Paso 1: Abriendo la carpeta por ID...");
    var folder = DriveApp.getFolderById(DEFAULT_DRIVE_FOLDER_ID);
    Logger.log("  ✓ Carpeta encontrada");
    Logger.log("  Nombre: " + folder.getName());
    Logger.log("  URL:    " + folder.getUrl());
    Logger.log("  Owner:  " + folder.getOwner().getEmail());

    Logger.log("");
    Logger.log("Paso 2: Creando un archivo de prueba en la carpeta...");
    var testFileName = "TEST_COE_" + new Date().getTime();
    var testSs = SpreadsheetApp.create(testFileName);
    var testFile = DriveApp.getFileById(testSs.getId());

    testFile.moveTo(folder);
    Logger.log("  ✓ Archivo movido a la carpeta con moveTo()");
    Logger.log("  Archivo: " + testFileName);
    Logger.log("  URL:     " + testSs.getUrl());

    Logger.log("");
    Logger.log("Paso 3: Verificando que el archivo esté en la carpeta...");
    var parents = testFile.getParents();
    var enCarpeta = false;
    var parentNames = [];
    while (parents.hasNext()) {
      var p = parents.next();
      parentNames.push(p.getName() + " (" + p.getId() + ")");
      if (p.getId() === DEFAULT_DRIVE_FOLDER_ID) enCarpeta = true;
    }
    Logger.log("  Parents del archivo: " + parentNames.join(", "));
    Logger.log("  ¿Está en la carpeta COE? " + (enCarpeta ? "SÍ ✓" : "NO ✗"));

    Logger.log("");
    Logger.log("Paso 4: Borrando el archivo de prueba...");
    testFile.setTrashed(true);
    Logger.log("  ✓ Archivo enviado a papelera");

    Logger.log("");
    Logger.log("═══════════════════════════════════════════════");
    if (enCarpeta) {
      Logger.log("  ✅ ÉXITO — La carpeta COE funciona correctamente.");
    } else {
      Logger.log("  ⚠ EL ARCHIVO SE CREÓ PERO NO QUEDÓ EN LA CARPETA.");
      Logger.log("  Revisa: el moveTo() puede haber fallado silenciosamente.");
    }
    Logger.log("═══════════════════════════════════════════════");

  } catch (err) {
    Logger.log("");
    Logger.log("═══════════════════════════════════════════════");
    Logger.log("  ❌ EXCEPCIÓN: " + err.message);
    Logger.log("═══════════════════════════════════════════════");
    Logger.log("Posibles causas:");
    Logger.log("");
    Logger.log("  1) La carpeta no existe con ese ID.");
    Logger.log("     → Verifica que sea el ID correcto en Drive.");
    Logger.log("     → Ve a la carpeta en Drive, y copia el ID de la URL.");
    Logger.log("");
    Logger.log("  2) La cuenta " + Session.getEffectiveUser().getEmail());
    Logger.log("     no tiene permiso de Editor sobre la carpeta.");
    Logger.log("     → Comparte la carpeta con esta cuenta como Editor.");
    Logger.log("");
    Logger.log("  3) El scope de Drive completo no está autorizado.");
    Logger.log("     → Ejecuta esta función para forzar re-autorización.");
    Logger.log("     → Acepta todos los permisos que Google pida.");
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  v15.0 · MÓDULO ADMIN
//
//  · La whitelist vive en la pestaña "Usuarios" del Sheet de auditoría.
//    La pestaña SE CREA Y SE SIEMBRA SOLA la primera vez (con ALLOWED_EMAILS):
//    el Sheet es solo almacenamiento, nunca se edita a mano.
//  · Todos los usuarios ven el panel (adminData); solo ADMIN_EMAILS edita.
//  · La verificación de admin es AQUÍ, en el backend, contra el email del
//    id_token verificado por Google. Ocultar botones en el frontend es
//    cosmético: cualquiera puede forzarlos desde la consola del navegador.
// ══════════════════════════════════════════════════════════════════════════

function esAdmin(email) {
  return ADMIN_EMAILS.indexOf(String(email || "").toLowerCase().trim()) !== -1;
}

// Devuelve la pestaña "Usuarios", creándola y sembrándola si no existe.
function obtenerHojaUsuarios() {
  var ss = SpreadsheetApp.openById(AUDIT_SHEET_ID);
  var sh = ss.getSheetByName(USUARIOS_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(USUARIOS_SHEET_NAME);
    sh.appendRow(["Email", "Agregado por", "Fecha"]);
    sh.getRange(1, 1, 1, 3).setFontWeight("bold").setBackground("#1e2235").setFontColor("#ffffff");
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 280); sh.setColumnWidth(2, 240); sh.setColumnWidth(3, 160);
    for (var i = 0; i < ALLOWED_EMAILS.length; i++) {
      sh.appendRow([ALLOWED_EMAILS[i], "sistema (migración v15)", new Date()]);
    }
    Logger.log("[USUARIOS] Pestaña creada y sembrada con " + ALLOWED_EMAILS.length + " usuarios.");
  }
  return sh;
}

// Whitelist dinámica con caché de 5 min y fallback a la lista hardcodeada.
function obtenerWhitelist() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(WHITELIST_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }
  try {
    if (!AUDIT_SHEET_ID) throw new Error("sin AUDIT_SHEET_ID");
    var sh = obtenerHojaUsuarios();
    var last = sh.getLastRow();
    var emails = [];
    if (last >= 2) {
      var vals = sh.getRange(2, 1, last - 1, 1).getValues();
      for (var i = 0; i < vals.length; i++) {
        var e = String(vals[i][0] || "").toLowerCase().trim();
        if (e.indexOf("@") > 0 && emails.indexOf(e) === -1) emails.push(e);
      }
    }
    // Los admins SIEMPRE están dentro, aunque alguien los borrara del Sheet
    for (var a = 0; a < ADMIN_EMAILS.length; a++) {
      if (emails.indexOf(ADMIN_EMAILS[a]) === -1) emails.push(ADMIN_EMAILS[a]);
    }
    if (emails.length > 0) {
      cache.put(WHITELIST_CACHE_KEY, JSON.stringify(emails), WHITELIST_CACHE_SEG);
      return emails;
    }
  } catch (err) {
    Logger.log("[WHITELIST FALLBACK] " + err.message + " — usando lista hardcodeada.");
  }
  return ALLOWED_EMAILS;
}

// v17: alta y baja bajo candado (dos admins a la vez podían duplicar o borrar la fila equivocada).
function conCandadoScript(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error("Otra persona está modificando usuarios. Intenta en unos segundos.");
  try { return fn(); } finally { lock.releaseLock(); }
}

// ── Alta de usuario (solo admins) ──
function adminAgregarUsuario(userEmail, payload) {
  if (!esAdmin(userEmail)) throw new Error("Solo los administradores pueden modificar usuarios.");
  var nuevo = String(payload.email || "").toLowerCase().trim();
  if (!/^[a-z0-9._%+-]+@docplanner\.com$/.test(nuevo)) {
    throw new Error("Solo se aceptan correos @docplanner.com válidos.");
  }
  return conCandadoScript(function() {
    CacheService.getScriptCache().remove(WHITELIST_CACHE_KEY);
    if (obtenerWhitelist().indexOf(nuevo) !== -1) {
      throw new Error(nuevo + " ya tiene acceso.");
    }
    var sh = obtenerHojaUsuarios();
    sh.appendRow([nuevo, neutralizarValorSheet(userEmail), new Date()]);
    CacheService.getScriptCache().remove(WHITELIST_CACHE_KEY);
    registrarAuditoria(userEmail, "admin", "add_user", "email=" + nuevo);
    return { ok: true, email: nuevo };
  });
}

// ── Baja de usuario (solo admins; con barandales anti-autobloqueo) ──
// v17: al quitar la whitelist del caché, los tokens ya cacheados de esa persona
// dejan de servir en su siguiente petición (validarIdToken revisa la whitelist).
function adminEliminarUsuario(userEmail, payload) {
  if (!esAdmin(userEmail)) throw new Error("Solo los administradores pueden modificar usuarios.");
  var objetivo = String(payload.email || "").toLowerCase().trim();
  if (!objetivo) throw new Error("No se recibió el email a eliminar.");
  if (esAdmin(objetivo)) throw new Error("No se puede eliminar a un administrador.");
  return conCandadoScript(function() {
    var sh = obtenerHojaUsuarios();
    var last = sh.getLastRow();
    var filas = [];
    if (last >= 2) {
      var vals = sh.getRange(2, 1, last - 1, 1).getValues();
      for (var i = 0; i < vals.length; i++) {
        if (String(vals[i][0] || "").toLowerCase().trim() === objetivo) filas.push(i + 2);
      }
    }
    if (!filas.length) throw new Error(objetivo + " no está en la lista.");
    // De abajo hacia arriba, por si estaba repetido
    for (var f = filas.length - 1; f >= 0; f--) sh.deleteRow(filas[f]);
    CacheService.getScriptCache().remove(WHITELIST_CACHE_KEY);
    registrarAuditoria(userEmail, "admin", "remove_user", "email=" + objetivo);
    return { ok: true, email: objetivo };
  });
}

// ── El agregador del panel: lee TODA la auditoría y computa todo de un golpe ──
function obtenerDatosAdmin(userEmail) {
  if (!AUDIT_SHEET_ID) throw new Error("La auditoría no está configurada (AUDIT_SHEET_ID vacío): el panel no tiene datos que mostrar.");

  var ss = SpreadsheetApp.openById(AUDIT_SHEET_ID);
  var audit = ss.getSheets()[0];
  var last = audit.getLastRow();
  var rows = (last >= 2) ? audit.getRange(2, 1, last - 1, 5).getValues() : [];

  var ahora = Date.now();
  var DIA = 86400000;
  var jobIniciado = {};   // jobId → {ts, email, det}
  var jobCerrado  = {};   // jobId → true
  var jobContado  = {};   // jobId → true (evita contar dos veces el mismo import)
  var negados = [];
  var porUsuario = {};    // email → {imports, ultimaActividad}
  var semanas = [];       // 8 cubetas: 0 = esta semana
  for (var s = 0; s < 8; s++) semanas.push({ imports: 0, procesados: 0, fallidos: 0 });
  var totProcesados = 0, totFallidos = 0, totImports = 0;
  var logRows = [];

  for (var i = 0; i < rows.length; i++) {
    var ts = rows[i][0] instanceof Date ? rows[i][0].getTime() : Date.parse(rows[i][0]);
    if (isNaN(ts)) ts = 0;
    var email  = String(rows[i][1] || "").toLowerCase().trim();
    var op     = String(rows[i][2] || "");
    var estado = String(rows[i][3] || "");
    var det    = String(rows[i][4] || "");

    var esUsuarioReal = (email.indexOf("@") > 0 && email.indexOf("test-") !== 0);

    // Última actividad por usuario
    if (esUsuarioReal) {
      if (!porUsuario[email]) porUsuario[email] = { imports: 0, ultimaActividad: 0 };
      if (ts > porUsuario[email].ultimaActividad) porUsuario[email].ultimaActividad = ts;
    }

    // Ciclo de vida de los jobs (para detectar huérfanos)
    // v17: un import puede tener varios jobs; se sigue por su lote. Los v16 no
    // tienen lote y se siguen por su jobId, como antes.
    var jm = det.match(/jobId=(750[a-zA-Z0-9]+)/);
    var lm = det.match(/lote=(lote_[a-f0-9]+)/);
    var llave = lm ? lm[1] : (jm ? jm[1] : null);
    if (llave && op === "import") {
      if (estado === "iniciado") jobIniciado[llave] = { ts: ts, email: email, det: det, jobId: jm ? jm[1] : "", loteId: lm ? lm[1] : "" };
      else if (ESTADOS_CIERRE_AUDIT[estado]) jobCerrado[llave] = true;
    } else if (jm && (estado === "success" || estado === "error")) {
      jobCerrado[llave] = true;   // recuperaciones manuales v16 ("recuperarJob")
    }

    // ── Métricas de imports · v16.2 ──
    // Un import cuenta UNA vez por jobId, sin importar cómo se llame la fila
    // que lo cierra:
    //   · "import"       → flujo síncrono viejo, y v16.2+ en adelante
    //   · "recuperarJob" → flujo asíncrono v14–v16.1, y recuperaciones manuales
    // Antes solo se contaba "import", así que TODOS los imports hechos con el
    // flujo asíncrono quedaban fuera de las métricas (imports 0, éxito 0).
    // El de-duplicado por jobId evita el problema inverso: que un job cerrado
    // y luego recuperado a mano se contara dos veces.
    if (estado === "success" && (op === "import" || op === "recuperarJob")) {
      var jid = llave;
      if (!jid || !jobContado[jid]) {
        if (jid) jobContado[jid] = true;
        totImports++;
        if (esUsuarioReal && porUsuario[email]) porUsuario[email].imports++;
        var pm = det.match(/processed=(\d+)/), fm = det.match(/failed=(\d+)/);
        var proc = pm ? parseInt(pm[1], 10) : 0, fall = fm ? parseInt(fm[1], 10) : 0;
        totProcesados += proc; totFallidos += fall;
        var sem = Math.floor((ahora - ts) / (7 * DIA));
        if (sem >= 0 && sem < 8) { semanas[sem].imports++; semanas[sem].procesados += proc; semanas[sem].fallidos += fall; }
      }
    }

    // Accesos denegados / rate limit
    if (estado === "no_autorizado" || estado === "auth_rechazado" || estado === "rate_limited") {
      negados.push({ ts: ts, email: email || "(desconocido)", estado: estado, det: det.slice(0, 140) });
    }

    logRows.push({ ts: ts, email: email, op: op, estado: estado, det: det.slice(0, 200) });
  }

  // Huérfanos: "iniciado" sin cierre, de los últimos 7 días (SF purga después)
  var huerfanos = [];
  for (var jobId in jobIniciado) {
    if (!jobCerrado[jobId] && (ahora - jobIniciado[jobId].ts) <= 7 * DIA) {
      huerfanos.push({
        jobId: jobIniciado[jobId].jobId || jobId,
        loteId: jobIniciado[jobId].loteId || "",
        email: jobIniciado[jobId].email,
        ts: jobIniciado[jobId].ts,
        edadMin: Math.round((ahora - jobIniciado[jobId].ts) / 60000),
        det: jobIniciado[jobId].det.slice(0, 140)
      });
    }
  }
  huerfanos.sort(function(a, b) { return b.ts - a.ts; });

  // Usuarios: pestaña + stats + rol
  var usuarios = [];
  var fuenteWhitelist = "";
  try {
    var sh = obtenerHojaUsuarios();
    var lastU = sh.getLastRow();
    if (lastU >= 2) {
      var vals = sh.getRange(2, 1, lastU - 1, 3).getValues();
      for (var u = 0; u < vals.length; u++) {
        var em = String(vals[u][0] || "").toLowerCase().trim();
        if (em.indexOf("@") <= 0) continue;
        var st = porUsuario[em] || { imports: 0, ultimaActividad: 0 };
        usuarios.push({
          email: em,
          esAdmin: esAdmin(em),
          agregadoPor: String(vals[u][1] || ""),
          fecha: vals[u][2] instanceof Date ? vals[u][2].getTime() : 0,
          imports: st.imports,
          ultimaActividad: st.ultimaActividad
        });
      }
    }
    fuenteWhitelist = "Pestaña Usuarios (" + usuarios.length + ")";
  } catch (e) {
    fuenteWhitelist = "FALLBACK: lista en código (" + ALLOWED_EMAILS.length + ") — " + e.message;
  }

  // Health check: escritura real al Sheet (celda auxiliar, se limpia sola) + carpeta COE
  var health = { version: VERSION_BACKEND, sheetLectura: true, sheetEscritura: false, carpetaCOE: "", whitelistFuente: fuenteWhitelist };
  try {
    var celda = audit.getRange(1, 8);  // H1: fuera de las 5 columnas del log
    celda.setValue("health_ok");
    celda.clearContent();
    health.sheetEscritura = true;
  } catch (e) { health.sheetEscritura = false; }
  try {
    health.carpetaCOE = DriveApp.getFolderById(DEFAULT_DRIVE_FOLDER_ID).getName();
  } catch (e) { health.carpetaCOE = ""; }

  // Log: últimas 300 filas, la más nueva primero
  logRows.sort(function(a, b) { return b.ts - a.ts; });
  negados.sort(function(a, b) { return b.ts - a.ts; });

  return {
    esAdmin: esAdmin(userEmail),
    admins: ADMIN_EMAILS,
    usuarios: usuarios,
    log: logRows.slice(0, 300),
    totalFilasLog: logRows.length,
    huerfanos: huerfanos,
    negados: negados.slice(0, 50),
    metricas: {
      totImports: totImports,
      totProcesados: totProcesados,
      totFallidos: totFallidos,
      pctExito: totProcesados > 0 ? Math.round(((totProcesados - totFallidos) / totProcesados) * 1000) / 10 : 0,
      semanas: semanas
    },
    health: health
  };
}
