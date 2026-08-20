// ══════════════════════════════════════════════════════════════════════════
//  SF ASIGNADOR · BACKEND — Google Apps Script  v15.0
//
//  Operaciones:
//    · default              → procesarAsignacion
//    · "describe"           → describirObjeto
//    · "importStart"        → iniciarImportBulk     ← v14: devuelve el jobId ya
//    · "jobStatus"          → consultarEstadoJob    ← v14: consulta corta (~1s)
//    · "recuperarJob"       → recuperarResultadoJob
//    · "import"             → ejecutarImportBulk    (legacy síncrono; se conserva
//                              como respaldo si un navegador tiene el front viejo
//                              en caché. El flujo nuevo NO lo usa.)
//    · "exportSheet"        → exportarResultadoASheet
//    · "exportSheetFromFile"→ exportarSheetDesdeArchivo (CSV/Excel local)
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
//    · Carpeta de Drive HARDCODEADA: 17Ah_wvZiEdxT3PQOqumR343dyeV17f25
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
var DEFAULT_DRIVE_FOLDER_ID = "17Ah_wvZiEdxT3PQOqumR343dyeV17f25";  // ← Carpeta COE (hardcodeada)
var SF_API_VERSION          = "v57.0";  // ← Versión de la API de Salesforce (un solo lugar para subirla)
var GOOGLE_CLIENT_ID        = "568964808002-hftmn4qnjikpfn4l8u6vefbqjjd63b5k.apps.googleusercontent.com";
var ALLOWED_DOMAIN          = "docplanner.com";

// ── SEGURIDAD: Whitelist de emails autorizados ──
// Solo estos emails pueden usar la herramienta (además del dominio).
// Para añadir/quitar acceso: modifica esta lista y re-despliega.
var ALLOWED_EMAILS = [
  "edgar.martinez@docplanner.com",
  "fernando.zamora@docplanner.com",
  "elvia.chaparro@docplanner.com",
  "servio.lima@docplanner.com",
  "guilherme.foppa@docplanner.com",
  "angelica.perez-celini@docplanner.com",
  "alejandro.zarate@docplanner.com",
  "camila.fernandez@docplanner.com",
  "andres.fraile@docplanner.com"
];

// ── ADMIN v15: administradores de la herramienta ──
// HARDCODEADOS a propósito (no editables desde el panel): si fueran editables,
// un error podría dejar a todos sin acceso al panel para arreglarlo.
// Todos los usuarios pueden VER el panel; solo estos emails pueden EDITAR.
var ADMIN_EMAILS = [
  "edgar.martinez@docplanner.com",
  "guilherme.foppa@docplanner.com"
];

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
// frontend repite cada 10s mientras dura un import; con el tope de 100/hora un
// import largo agotaría el límite del propio usuario. No hay riesgo de abuso:
// requiere id_token válido + un jobId existente, y no descarga datos.
var RATE_LIMIT_OPERACIONES   = ["asignacion", "import", "importStart", "exportSheet", "exportSheetFromFile", "recuperarJob"];

// ── SEGURIDAD: campos que NUNCA se logean (sanitización) ──
var CAMPOS_SENSIBLES = ["sid", "idToken", "fileContent", "access_token", "accessToken", "password"];

// Auditoría: pega aquí el ID de un Google Sheet donde se registrarán los imports.
// Deja "" para desactivar. La hoja debe estar compartida con la cuenta que desplegó el script.
var AUDIT_SHEET_ID = "17tUa2MGi1QpXpIKsgv-zOsqM5jnBUh_wOc_PfxI3N3U";  // ← Opcional: crea un Sheet vacío en tu Drive y pega su ID aquí


function doPost(e) {
  var output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  var payload = null;
  var userEmail = "";
  var operation = "";

  try {
    payload = JSON.parse(e.postData.contents);
    operation = payload.action || "asignacion";

    // ── CAPA 1: validar id_token de Google (dominio + whitelist) ──
    var tokenValidation = validarIdToken(payload.idToken);
    if (!tokenValidation.valid) {
      // Registrar rechazo — útil para detectar intentos de acceso no autorizado
      registrarAuditoria(
        tokenValidation.email || "(desconocido)",
        operation,
        tokenValidation.notAuthorized ? "no_autorizado" : "auth_rechazado",
        tokenValidation.error
      );
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

    // ── CAPA 2: rate limiting solo para operaciones costosas ──
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

    // ── EJECUTAR OPERACIÓN ──
    var resultado;
    if (operation === "import") {
      resultado = ejecutarImportBulk(payload);
      // AUDITORÍA solo de imports (según solicitud del usuario)
      var auditDetails = "jobId=" + (resultado.jobId || "N/A") +
                         "; state=" + (resultado.jobState || "N/A") +
                         "; processed=" + (resultado.processed || 0) +
                         "; failed=" + (resultado.failed || 0) +
                         "; rows=" + (payload.rows ? payload.rows.length : 0);
      registrarAuditoria(userEmail, operation, "success", auditDetails);
    } else if (operation === "importStart") {
      // v14: arranca el job y devuelve el jobId de inmediato.
      // La auditoría "iniciado" se escribe DENTRO, en cuanto Salesforce
      // asigna el jobId, para que nunca se pierda el rastro.
      resultado = iniciarImportBulk(payload);
    } else if (operation === "jobStatus") {
      // v14: consulta corta que el frontend repite. Sin auditoría (sería ruido).
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
      // Auditar la recuperación de un job
      registrarAuditoria(userEmail, operation, "success",
        "jobId=" + (resultado.jobId || "N/A") + "; state=" + (resultado.jobState || "N/A") +
        "; processed=" + (resultado.processed || 0) + "; failed=" + (resultado.failed || 0));
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
    output.setContent(JSON.stringify({
      error: err.message
    }));

    // Auditoría solo si es import (fallido)
    if (operation === "import") {
      registrarAuditoria(userEmail, operation, "error", String(err.message).slice(0, 300));
    }
  }

  return output;
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: "OK", version: "15.0" }))
    .setMimeType(ContentService.MimeType.JSON);
}


// ══════════════════════════════════════════════════════════════════════════
//  VALIDACIÓN DE id_token DE GOOGLE
//  Verifica el JWT contra el endpoint oficial de Google (tokeninfo).
//  Cachea tokens válidos por 5 min para reducir llamadas.
// ══════════════════════════════════════════════════════════════════════════
function validarIdToken(idToken) {
  if (!idToken || typeof idToken !== "string") {
    return { valid: false, error: "No se envió id_token" };
  }

  var cache = CacheService.getScriptCache();
  var cacheKey = "tok_" + idToken.slice(-32);  // últimos 32 chars como key
  var cached = cache.get(cacheKey);
  if (cached) {
    var cachedObj = JSON.parse(cached);
    return { valid: true, email: cachedObj.email };
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
    var now = Math.floor(Date.now() / 1000);
    if (parseInt(info.exp) < now) {
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

    // Cachear por 5 minutos
    cache.put(cacheKey, JSON.stringify({ email: emailLower }), 300);

    return { valid: true, email: emailLower };
  } catch (err) {
    return { valid: false, error: "Excepción validando token: " + err.message };
  }
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

    sheet.appendRow([
      new Date(),
      userEmail || "(vacío)",
      operation || "(vacío)",
      status || "(vacío)",
      String(details || "").slice(0, 500)
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
  var dias         = params.dias;
  var businessLine = params.businessLine;
  var reps         = params.reps;
  var idsRaw       = params.ids || [];
  var extraFieldsRaw  = params.extraFields   || [];  // Campos custom del Contact (columnas adicionales)
  var fieldsFromSFRaw = params.fieldsFromSF  || [];  // Campos base cuyo valor debe venir de SF en vez del hardcoded

  var idsContactos = idsRaw.filter(function(id) { return id && String(id).trim().length > 0; });
  if (!idsContactos.length) throw new Error("No hay IDs de contactos válidos.");

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

  var emailsList = reps.map(function(r) { return "'" + escapeSoql(r.email) + "'"; });
  var soqlUsers = "SELECT Id, Email, Username FROM User WHERE Email IN (" + emailsList.join(",") + ") OR Username IN (" + emailsList.join(",") + ")";
  var urlUsers  = instanceUrl + "/services/data/" + SF_API_VERSION + "/query/?q=" + encodeURIComponent(soqlUsers);
  var resUsers  = UrlFetchApp.fetch(urlUsers, opciones);
  var jsonUsers = JSON.parse(resUsers.getContentText());

  if (!jsonUsers.records) throw new Error("Salesforce no devolvió registros. Verifica el SID. " + JSON.stringify(jsonUsers).slice(0, 300));

  var mapUserIds = {};
  jsonUsers.records.forEach(function(u) {
    if (u.Email)    mapUserIds[u.Email.toLowerCase().trim()]    = u.Id;
    if (u.Username) mapUserIds[u.Username.toLowerCase().trim()] = u.Id;
  });

  var cuotasReps = {};
  reps.forEach(function(r) { cuotasReps[r.email.toLowerCase().trim()] = r.cuota; });

  // El valor de días se usa tal cual: puede ser 0, 30, 60, 90, etc.
  // Si el usuario deja el campo vacío, se toma como 0 (query se ejecuta con LAST_N_DAYS:0).
  var diasFinal = (dias === "" || dias === null || dias === undefined) ? 0 : parseInt(dias) || 0;
  var poolContactos = [];
  var tamanoBloque = 40;
  var bloquesFallidos = 0;  // v12.0: bloques de query que fallaron (antes se perdían en silencio)

  for (var i = 0; i < idsContactos.length; i += tamanoBloque) {
    var bloque = idsContactos.slice(i, i + tamanoBloque);
    var idsFormateados = bloque.map(function(id) { return "'" + escapeSoql(String(id).trim()) + "'"; }).join(",");

    // ÚNICA query de asignación: siempre usa la exclusión con LAST_N_DAYS.
    // Excluye contactos con Opportunities abiertas o cerradas en los últimos N días,
    // y contactos con Leads NO convertidos en estados activos o cerrados en los últimos N días.
    // Construir SELECT dinámico: 5 campos base + extraFieldsSF (columnas custom desde Contact) + fieldsFromSF (sobrescriben hardcodeados)
    // Los custom manuales NO van al SELECT porque su valor es fijo y no depende del Contact
    var selectFields = ["Id", "LastSourceAt__c", "Account.Name", "LastName", "Email"];
    for (var ef = 0; ef < extraFieldsSF.length; ef++) selectFields.push(extraFieldsSF[ef].name);
    for (var fi = 0; fi < fieldsFromSF.length; fi++) {
      if (selectFields.indexOf(fieldsFromSF[fi]) === -1) selectFields.push(fieldsFromSF[fi]);
    }
    var selectClause = selectFields.join(", ");

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

    var urlContactos = instanceUrl + "/services/data/" + SF_API_VERSION + "/query/?q=" + encodeURIComponent(soqlContactos);
    try {
      var resContactos  = UrlFetchApp.fetch(urlContactos, opciones);
      var jsonContactos = JSON.parse(resContactos.getContentText());
      if (jsonContactos.records) {
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
    } catch (err) { bloquesFallidos++; Logger.log("Error bloque " + i + ": " + err.message); }
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
    mensaje += " ⚠ OJO: " + bloquesFallidos + " bloque(s) de contactos fallaron en la query y NO entraron al pool. Revisa el log de Apps Script o reintenta.";
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
//  BULK IMPORT (sin cambios)
// ══════════════════════════════════════════════════════════════════════════
function ejecutarImportBulk(params) {
  var sid = params.sid, instanceUrl = params.instanceUrl;
  var object = params.object || "Lead", operation = params.operation || "insert";
  var externalId = params.externalId || "", headers = params.headers, rows = params.rows;

  if (!rows || !rows.length) throw new Error("No se recibieron filas.");
  if (!headers || !headers.length) throw new Error("No se recibieron headers.");

  var csvLines = [];
  csvLines.push(headers.map(function(h){ return '"' + String(h).replace(/"/g,'""') + '"'; }).join(","));
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i] || [], cells = [];
    for (var j = 0; j < headers.length; j++) {
      var v = row[j];
      if (v === null || v === undefined) v = "";
      v = String(v).replace(/"/g, '""');
      cells.push('"' + v + '"');
    }
    csvLines.push(cells.join(","));
  }

  var csvContent = csvLines.join("\n");
  var base = instanceUrl + "/services/data/" + SF_API_VERSION;
  var jsonHeaders = { "Authorization": "Bearer " + sid, "Content-Type": "application/json", "Accept": "application/json" };

  var jobBody = { object: object, operation: operation, contentType: "CSV", lineEnding: "LF" };
  if (operation === "upsert" && externalId) jobBody.externalIdFieldName = externalId;

  var jobRes = UrlFetchApp.fetch(base + "/jobs/ingest", { method: "post", headers: jsonHeaders, payload: JSON.stringify(jobBody), muteHttpExceptions: true });
  if (jobRes.getResponseCode() < 200 || jobRes.getResponseCode() >= 300) throw new Error("Error creando Job: " + jobRes.getContentText().slice(0, 400));
  var jobId = JSON.parse(jobRes.getContentText()).id;

  var uploadRes = UrlFetchApp.fetch(base + "/jobs/ingest/" + jobId + "/batches", {
    method: "put",
    headers: { "Authorization": "Bearer " + sid, "Content-Type": "text/csv", "Accept": "application/json" },
    payload: csvContent, muteHttpExceptions: true
  });
  if (uploadRes.getResponseCode() < 200 || uploadRes.getResponseCode() >= 300) throw new Error("Error subiendo CSV: " + uploadRes.getContentText().slice(0, 400));

  var closeRes = UrlFetchApp.fetch(base + "/jobs/ingest/" + jobId, { method: "patch", headers: jsonHeaders, payload: JSON.stringify({ state: "UploadComplete" }), muteHttpExceptions: true });
  if (closeRes.getResponseCode() < 200 || closeRes.getResponseCode() >= 300) throw new Error("Error cerrando Job: " + closeRes.getContentText().slice(0, 400));

  // POLLING: Apps Script tiene un límite duro de 6 min de ejecución total.
  // Ya se gastaron ~15-20s en crear job + subir CSV + cerrar. Reservamos margen.
  // 110 intentos × 3s = 5.5 min de espera máxima (antes: 75 × 4s = 5 min).
  // Si el job sigue InProgress al agotar el polling, devolvemos el estado parcial
  // con el jobId para que el frontend pueda recuperar el resultado después.
  var MAX_POLL_ATTEMPTS = 110;
  var POLL_INTERVAL_MS  = 3000;
  var jobState = "UploadComplete", pollData = {}, attempts = 0;
  while (jobState !== "JobComplete" && jobState !== "Failed" && jobState !== "Aborted" && attempts < MAX_POLL_ATTEMPTS) {
    Utilities.sleep(POLL_INTERVAL_MS);
    attempts++;
    var pollRes = UrlFetchApp.fetch(base + "/jobs/ingest/" + jobId, { method: "get", headers: jsonHeaders, muteHttpExceptions: true });
    if (pollRes.getResponseCode() === 200) {
      pollData = JSON.parse(pollRes.getContentText());
      jobState = pollData.state || jobState;
    }
  }

  // Flag: el job no terminó dentro de la ventana de polling (sigue procesando en Salesforce)
  var timedOut = (jobState !== "JobComplete" && jobState !== "Failed" && jobState !== "Aborted");

  var okCsv = "", failCsv = "";
  try { var okRes = UrlFetchApp.fetch(base + "/jobs/ingest/" + jobId + "/successfulResults", { method: "get", headers: { "Authorization": "Bearer " + sid, "Accept": "text/csv" }, muteHttpExceptions: true }); if (okRes.getResponseCode() === 200) okCsv = okRes.getContentText(); } catch (e) {}
  try { var failRes = UrlFetchApp.fetch(base + "/jobs/ingest/" + jobId + "/failedResults", { method: "get", headers: { "Authorization": "Bearer " + sid, "Accept": "text/csv" }, muteHttpExceptions: true }); if (failRes.getResponseCode() === 200) failCsv = failRes.getContentText(); } catch (e) {}

  var errorMessage = "";
  if (jobState === "Failed" || jobState === "Aborted") errorMessage = pollData.errorMessage || "Sin mensaje de error";

  return {
    jobId: jobId, jobState: jobState,
    successCsv: okCsv, failedCsv: failCsv,
    processed: pollData.numberRecordsProcessed || 0,
    failed: pollData.numberRecordsFailed || 0,
    errorMessage: errorMessage,
    timedOut: timedOut
  };
}


// ══════════════════════════════════════════════════════════════════════════
//  RECUPERAR RESULTADO DE UN JOB EXISTENTE (por Job ID)
//  Se usa cuando el import original excedió la ventana de polling y quedó
//  InProgress en la UI, pero Salesforce ya terminó de procesarlo.
//  Consulta el estado actual del job + descarga sus CSVs de resultado.
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
//  v14.0 · IMPORT ASÍNCRONO — iniciarImportBulk + consultarEstadoJob
//
//  POR QUÉ EXISTEN:
//  ejecutarImportBulk() hace crear+subir+cerrar+ESPERAR+descargar dentro de
//  una sola petición. Ese "esperar" (Utilities.sleep en bucle, hasta 5.5 min)
//  choca contra el límite duro de 6 min de Apps Script: con volúmenes altos la
//  ejecución muere y se pierde el jobId, aunque Salesforce sí haya terminado.
//
//  LA SOLUCIÓN NO ES PARTIR LOS DATOS (eso traicionaría a Bulk API 2.0, que
//  está diseñada para un solo job), sino PARTIR LA ESPERA:
//    · iniciarImportBulk  → crea/sube/cierra y devuelve el jobId  (~20s)
//    · consultarEstadoJob → una pregunta corta, la repite el frontend (~1s)
//    · recuperarResultadoJob (ya existía) → resultados, una sola vez al final
//  Ninguna petición se acerca al límite, sin importar el volumen.
// ══════════════════════════════════════════════════════════════════════════
function iniciarImportBulk(params) {
  var sid = params.sid, instanceUrl = params.instanceUrl;
  var object = params.object || "Lead", operation = params.operation || "insert";
  var externalId = params.externalId || "", headers = params.headers, rows = params.rows;
  var userEmail = params.userEmail || "";

  if (!rows || !rows.length) throw new Error("No se recibieron filas.");
  if (!headers || !headers.length) throw new Error("No se recibieron headers.");

  // CSV: mismo formato exacto que ejecutarImportBulk (no cambia el dato enviado)
  var csvLines = [];
  csvLines.push(headers.map(function(h){ return '"' + String(h).replace(/"/g,'""') + '"'; }).join(","));
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i] || [], cells = [];
    for (var j = 0; j < headers.length; j++) {
      var v = row[j];
      if (v === null || v === undefined) v = "";
      v = String(v).replace(/"/g, '""');
      cells.push('"' + v + '"');
    }
    csvLines.push(cells.join(","));
  }
  var csvContent = csvLines.join("\n");

  var base = instanceUrl + "/services/data/" + SF_API_VERSION;
  var jsonHeaders = { "Authorization": "Bearer " + sid, "Content-Type": "application/json", "Accept": "application/json" };

  // ── PASO 1: crear el job ──
  var jobBody = { object: object, operation: operation, contentType: "CSV", lineEnding: "LF" };
  if (operation === "upsert" && externalId) jobBody.externalIdFieldName = externalId;

  var jobRes = UrlFetchApp.fetch(base + "/jobs/ingest", {
    method: "post", headers: jsonHeaders, payload: JSON.stringify(jobBody), muteHttpExceptions: true
  });
  if (jobRes.getResponseCode() < 200 || jobRes.getResponseCode() >= 300) {
    throw new Error("Error creando Job: " + jobRes.getContentText().slice(0, 400));
  }
  var jobId = JSON.parse(jobRes.getContentText()).id;

  // ── AUDITORÍA AL NACER ──
  // Se escribe AQUÍ, no al final: aunque todo lo demás falle, el jobId ya
  // quedó registrado y el import siempre se puede recuperar.
  registrarAuditoria(userEmail, "import", "iniciado",
    "jobId=" + jobId + "; object=" + object + "; op=" + operation + "; rows=" + rows.length);

  // ── PASOS 2 y 3: subir el CSV y cerrar el job ──
  // Si algo falla aquí, se audita CON el jobId para no perder el rastro.
  try {
    var uploadRes = UrlFetchApp.fetch(base + "/jobs/ingest/" + jobId + "/batches", {
      method: "put",
      headers: { "Authorization": "Bearer " + sid, "Content-Type": "text/csv", "Accept": "application/json" },
      payload: csvContent, muteHttpExceptions: true
    });
    if (uploadRes.getResponseCode() < 200 || uploadRes.getResponseCode() >= 300) {
      throw new Error("Error subiendo CSV: " + uploadRes.getContentText().slice(0, 400));
    }

    var closeRes = UrlFetchApp.fetch(base + "/jobs/ingest/" + jobId, {
      method: "patch", headers: jsonHeaders,
      payload: JSON.stringify({ state: "UploadComplete" }), muteHttpExceptions: true
    });
    if (closeRes.getResponseCode() < 200 || closeRes.getResponseCode() >= 300) {
      throw new Error("Error cerrando Job: " + closeRes.getContentText().slice(0, 400));
    }
  } catch (err) {
    registrarAuditoria(userEmail, "import", "error_al_iniciar",
      "jobId=" + jobId + "; " + String(err.message).slice(0, 250));
    throw err;
  }

  // Devuelve de inmediato: el frontend se encarga de preguntar por el estado.
  return {
    jobId: jobId,
    jobState: "UploadComplete",
    total: rows.length,
    object: object,
    operation: operation
  };
}


// ══════════════════════════════════════════════════════════════════════════
//  CONSULTA LIGERA DE ESTADO — la repite el frontend cada pocos segundos.
//  Solo pregunta el estado del job: NO descarga los CSV de resultado, por eso
//  tarda ~1s y queda fuera del rate limit (ver RATE_LIMIT_OPERACIONES).
//  Los contadores vienen de Salesforce, así que la barra de progreso del
//  frontend puede mostrar avance REAL en vez de una animación estimada.
// ══════════════════════════════════════════════════════════════════════════
function consultarEstadoJob(params) {
  var sid = params.sid, instanceUrl = params.instanceUrl;
  var jobId = String(params.jobId || "").trim();

  if (!jobId) throw new Error("No se recibió un Job ID.");
  if (!/^750[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/.test(jobId)) {
    throw new Error("El Job ID no tiene un formato válido. Debe empezar con '750'.");
  }

  var res = UrlFetchApp.fetch(
    instanceUrl + "/services/data/" + SF_API_VERSION + "/jobs/ingest/" + jobId,
    { method: "get", headers: { "Authorization": "Bearer " + sid, "Accept": "application/json" }, muteHttpExceptions: true }
  );

  var code = res.getResponseCode();
  if (code === 401) throw new Error("Tu sesión de Salesforce expiró. Pega un SID nuevo y vuelve a consultar (el job sigue corriendo en Salesforce).");
  if (code === 404) throw new Error("No se encontró un Job con ese ID. Salesforce conserva los jobs ~7 días.");
  if (code !== 200) throw new Error("Salesforce devolvió HTTP " + code + " al consultar el Job.");

  var d = JSON.parse(res.getContentText());
  var state = d.state || "Unknown";
  var terminado = (state === "JobComplete" || state === "Failed" || state === "Aborted");

  return {
    jobId: jobId,
    jobState: state,
    processed: d.numberRecordsProcessed || 0,
    failed: d.numberRecordsFailed || 0,
    terminado: terminado,
    errorMessage: (state === "Failed" || state === "Aborted") ? (d.errorMessage || "Sin mensaje de error") : ""
  };
}

function recuperarResultadoJob(params) {
  var sid = params.sid, instanceUrl = params.instanceUrl;
  var jobId = String(params.jobId || "").trim();

  if (!jobId) throw new Error("No se recibió un Job ID.");
  // Validación básica del formato de Job ID (prefijo 750, 15 o 18 chars alfanuméricos)
  if (!/^750[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/.test(jobId)) {
    throw new Error("El Job ID no tiene un formato válido. Debe empezar con '750' (ej. 750Tt00000gk1XBIAY).");
  }

  var base = instanceUrl + "/services/data/" + SF_API_VERSION;
  var jsonHeaders = { "Authorization": "Bearer " + sid, "Accept": "application/json" };

  // Consultar el estado actual del job
  var pollRes = UrlFetchApp.fetch(base + "/jobs/ingest/" + jobId, { method: "get", headers: jsonHeaders, muteHttpExceptions: true });
  var code = pollRes.getResponseCode();
  if (code === 404) throw new Error("No se encontró un Job con ese ID. Verifica el Job ID o puede que Salesforce ya lo haya purgado (se conservan ~7 días).");
  if (code !== 200) throw new Error("Salesforce devolvió HTTP " + code + " al consultar el Job: " + pollRes.getContentText().slice(0, 300));

  var pollData = JSON.parse(pollRes.getContentText());
  var jobState = pollData.state || "Unknown";

  // Descargar los CSV de resultado (successful y failed)
  var okCsv = "", failCsv = "";
  try { var okRes = UrlFetchApp.fetch(base + "/jobs/ingest/" + jobId + "/successfulResults", { method: "get", headers: { "Authorization": "Bearer " + sid, "Accept": "text/csv" }, muteHttpExceptions: true }); if (okRes.getResponseCode() === 200) okCsv = okRes.getContentText(); } catch (e) {}
  try { var failRes = UrlFetchApp.fetch(base + "/jobs/ingest/" + jobId + "/failedResults", { method: "get", headers: { "Authorization": "Bearer " + sid, "Accept": "text/csv" }, muteHttpExceptions: true }); if (failRes.getResponseCode() === 200) failCsv = failRes.getContentText(); } catch (e) {}

  var errorMessage = "";
  if (jobState === "Failed" || jobState === "Aborted") errorMessage = pollData.errorMessage || "Sin mensaje de error";

  var stillProcessing = (jobState !== "JobComplete" && jobState !== "Failed" && jobState !== "Aborted");

  return {
    jobId: jobId,
    jobState: jobState,
    successCsv: okCsv,
    failedCsv: failCsv,
    processed: pollData.numberRecordsProcessed || 0,
    failed: pollData.numberRecordsFailed || 0,
    errorMessage: errorMessage,
    stillProcessing: stillProcessing,
    // Metadatos útiles del job
    object: pollData.object || "",
    operation: pollData.operation || "",
    createdDate: pollData.createdDate || ""
  };
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

  var summarySheet      = anadirHoja(ss, "Summary");
  var preTemplateSheet  = anadirHoja(ss, "Pre Template");
  var importResultSheet = anadirHoja(ss, "Import Result");

  llenarSummarySheet(summarySheet, summary);
  if (preTemplateHeaders.length && preTemplateRows.length) llenarHojaConDatos(preTemplateSheet, preTemplateHeaders, preTemplateRows);
  else preTemplateSheet.getRange(1,1).setValue("Sin datos de Pre Template.");
  if (importResultHeaders.length && importResultRows.length) llenarHojaConDatos(importResultSheet, importResultHeaders, importResultRows);
  else importResultSheet.getRange(1,1).setValue("Sin resultado de import.");

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
      // Normalizar filas al mismo número de columnas
      var normalized = csvData.map(function(r) {
        while (r.length < maxCols) r.push("");
        return r;
      });
      receivedSheet.getRange(1, 1, normalized.length, maxCols).setValues(normalized);
      receivedSheet.setFrozenRows(1);
    }

    // Borrar el archivo temporal subido
    try { DriveApp.getFileById(uploadedFileId).setTrashed(true); } catch(e) {}
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

  // Añadir las 3 hojas nuevas
  var summarySheet      = anadirHoja(ss, "Summary");
  var preTemplateSheet  = anadirHoja(ss, "Pre Template");
  var importResultSheet = anadirHoja(ss, "Import Result");

  llenarSummarySheet(summarySheet, summary);
  if (preTemplateHeaders.length && preTemplateRows.length) llenarHojaConDatos(preTemplateSheet, preTemplateHeaders, preTemplateRows);
  else preTemplateSheet.getRange(1,1).setValue("Sin datos de Pre Template.");
  if (importResultHeaders.length && importResultRows.length) llenarHojaConDatos(importResultSheet, importResultHeaders, importResultRows);
  else importResultSheet.getRange(1,1).setValue("Sin resultado de import.");

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

function llenarHojaConDatos(sheet, headers, rows) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
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

function llenarSummarySheet(sheet, summary) {
  var ownerStats = summary.ownerStats || [];
  var meta       = summary.meta       || {};

  sheet.getRange(1, 1).setValue("Resumen de Asignación e Import")
       .setFontSize(14).setFontWeight("bold").setFontColor("#4b7cf3");

  var row = 3;
  if (meta.fecha)         { sheet.getRange(row, 1).setValue("Fecha:");         sheet.getRange(row, 2).setValue(neutralizarValorSheet(meta.fecha));         row++; }
  if (meta.ejecutadoPor)  { sheet.getRange(row, 1).setValue("Ejecutado por:"); sheet.getRange(row, 2).setValue(neutralizarValorSheet(meta.ejecutadoPor)).setFontWeight("bold"); row++; }
  if (meta.businessLine)  { sheet.getRange(row, 1).setValue("Business Line:"); sheet.getRange(row, 2).setValue(neutralizarValorSheet(meta.businessLine));  row++; }
  if (meta.dias !== undefined && meta.dias !== null && meta.dias !== "") {
    sheet.getRange(row, 1).setValue("Días exclusión:");
    sheet.getRange(row, 2).setValue(meta.dias === 0 ? "Sin filtro" : meta.dias);
    row++;
  }

  var startRow = row + 2;
  sheet.getRange(startRow, 1).setValue("Owner (email)").setFontWeight("bold").setBackground("#1e2235").setFontColor("#ffffff");
  sheet.getRange(startRow, 2).setValue("Leads asignados").setFontWeight("bold").setBackground("#1e2235").setFontColor("#ffffff");

  if (ownerStats.length > 0) {
    var ownerData = ownerStats.map(function(o) { return [neutralizarValorSheet(o.email), o.count]; });
    sheet.getRange(startRow + 1, 1, ownerData.length, 2).setValues(ownerData);
    var totalRow = startRow + 1 + ownerData.length;
    sheet.getRange(totalRow, 1).setValue("TOTAL").setFontWeight("bold").setBackground("#f0f0f0");
    sheet.getRange(totalRow, 2).setValue("=SUM(B" + (startRow+1) + ":B" + (totalRow-1) + ")").setFontWeight("bold").setBackground("#f0f0f0");
  }

  sheet.getRange(startRow, 4).setValue("Contactos asignados").setFontWeight("bold").setBackground("#1e2235").setFontColor("#ffffff");
  sheet.getRange(startRow, 5).setValue("Representantes activos").setFontWeight("bold").setBackground("#1e2235").setFontColor("#ffffff");
  sheet.getRange(startRow, 6).setValue("Contactos que pasaron el query").setFontWeight("bold").setBackground("#1e2235").setFontColor("#ffffff");
  sheet.getRange(startRow + 1, 4).setValue(summary.contactosAsignados || 0);
  sheet.getRange(startRow + 1, 5).setValue(summary.repsActivos || 0);
  sheet.getRange(startRow + 1, 6).setValue(summary.contactosQueryPass || 0);

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, 6);
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

// ── Alta de usuario (solo admins) ──
function adminAgregarUsuario(userEmail, payload) {
  if (!esAdmin(userEmail)) throw new Error("Solo los administradores pueden modificar usuarios.");
  var nuevo = String(payload.email || "").toLowerCase().trim();
  if (!/^[a-z0-9._%+-]+@docplanner\.com$/.test(nuevo)) {
    throw new Error("Solo se aceptan correos @docplanner.com válidos.");
  }
  if (obtenerWhitelist().indexOf(nuevo) !== -1) {
    throw new Error(nuevo + " ya tiene acceso.");
  }
  var sh = obtenerHojaUsuarios();
  sh.appendRow([nuevo, userEmail, new Date()]);
  CacheService.getScriptCache().remove(WHITELIST_CACHE_KEY);
  registrarAuditoria(userEmail, "admin", "add_user", "email=" + nuevo);
  return { ok: true, email: nuevo };
}

// ── Baja de usuario (solo admins; con barandales anti-autobloqueo) ──
function adminEliminarUsuario(userEmail, payload) {
  if (!esAdmin(userEmail)) throw new Error("Solo los administradores pueden modificar usuarios.");
  var objetivo = String(payload.email || "").toLowerCase().trim();
  if (!objetivo) throw new Error("No se recibió el email a eliminar.");
  if (esAdmin(objetivo)) throw new Error("No se puede eliminar a un administrador.");
  var sh = obtenerHojaUsuarios();
  var last = sh.getLastRow();
  var fila = -1;
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0] || "").toLowerCase().trim() === objetivo) { fila = i + 2; break; }
    }
  }
  if (fila === -1) throw new Error(objetivo + " no está en la lista.");
  sh.deleteRow(fila);
  CacheService.getScriptCache().remove(WHITELIST_CACHE_KEY);
  registrarAuditoria(userEmail, "admin", "remove_user", "email=" + objetivo);
  return { ok: true, email: objetivo };
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

    // Última actividad + conteo de imports por usuario (solo emails reales)
    if (email.indexOf("@") > 0 && email.indexOf("test-") !== 0) {
      if (!porUsuario[email]) porUsuario[email] = { imports: 0, ultimaActividad: 0 };
      if (ts > porUsuario[email].ultimaActividad) porUsuario[email].ultimaActividad = ts;
      if (op === "import" && estado === "success") porUsuario[email].imports++;
    }

    // Ciclo de vida de los jobs (para detectar huérfanos)
    var jm = det.match(/jobId=(750[a-zA-Z0-9]+)/);
    if (jm) {
      if (op === "import" && estado === "iniciado") jobIniciado[jm[1]] = { ts: ts, email: email, det: det };
      else if (estado === "success" || estado === "error") jobCerrado[jm[1]] = true;
    }

    // Métricas de imports exitosos
    if (op === "import" && estado === "success") {
      totImports++;
      var pm = det.match(/processed=(\d+)/), fm = det.match(/failed=(\d+)/);
      var proc = pm ? parseInt(pm[1], 10) : 0, fall = fm ? parseInt(fm[1], 10) : 0;
      totProcesados += proc; totFallidos += fall;
      var sem = Math.floor((ahora - ts) / (7 * DIA));
      if (sem >= 0 && sem < 8) { semanas[sem].imports++; semanas[sem].procesados += proc; semanas[sem].fallidos += fall; }
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
        jobId: jobId,
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
  var health = { version: "15.0", sheetLectura: true, sheetEscritura: false, carpetaCOE: "", whitelistFuente: fuenteWhitelist };
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
