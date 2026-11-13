// Plantilla: cópiala a backend/config.local.gs y pon los valores reales. Se sube a Apps Script con clasp, nunca a GitHub.

// Carpeta de Drive (COE) donde se crean los exportes por defecto.
var DEFAULT_DRIVE_FOLDER_ID = "ID_DE_LA_CARPETA_DE_DRIVE";

// Respaldo de la whitelist: solo se usa si la pestaña "Usuarios" del Sheet de auditoría no responde.
// El día a día se administra desde el panel de la tool.
var ALLOWED_EMAILS = [
  "persona@docplanner.com"
];

// Administradores (pueden editar el panel). Fijos aquí a propósito: si fueran editables,
// un error podría dejar a todos sin acceso al panel.
var ADMIN_EMAILS = [
  "admin@docplanner.com"
];

// Sheet de auditoría (también guarda la pestaña "Usuarios"). Debe estar compartido con la cuenta que publica.
var AUDIT_SHEET_ID = "ID_DEL_SHEET_DE_AUDITORIA";
