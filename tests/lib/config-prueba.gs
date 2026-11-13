// Configuración falsa para las pruebas (tests/lib/cargar.js y el simulador la cargan antes de Code.gs).

// Carpeta de Drive (COE) donde se crean los exportes por defecto.
var DEFAULT_DRIVE_FOLDER_ID = "carpeta_prueba";

// Respaldo de la whitelist: solo se usa si la pestaña "Usuarios" del Sheet de auditoría no responde.
// El día a día se administra desde el panel de la tool.
var ALLOWED_EMAILS = [
  "usuario.prueba@docplanner.com",
  "admin.prueba@docplanner.com",
  "simulacion@docplanner.com"   // el usuario del simulador del navegador
];

// Administradores (pueden editar el panel). Fijos aquí a propósito: si fueran editables,
// un error podría dejar a todos sin acceso al panel.
var ADMIN_EMAILS = [
  "admin.prueba@docplanner.com"
];

// Sheet de auditoría (también guarda la pestaña "Usuarios"). Debe estar compartido con la cuenta que publica.
var AUDIT_SHEET_ID = "sheet_prueba";
