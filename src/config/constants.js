//   ALLOWED_ORIGINS=https://crm.tudominio.com,https://www.tudominio.com
const DEFAULT_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

export const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean)
  : DEFAULT_ORIGINS;

export const MAX_SOCKET_CONNECTIONS = 10;
export const PORT = process.env.PORT || 3001;

export const TRIGGER_N8N_URL = process.env.TRIGGER_N8N_URL;
export const TRIGGER_N8N_OUTGOING_URL = process.env.TRIGGER_N8N_OUTGOING_URL;

// Configuracion de rate limiting
export const RATE_LIMIT_CONFIG = {
  auth: {
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: {
      success: false,
      message: "Demasiados intentos, intenta más tarde",
    },
  },
  general: {
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 30, // 30 peticiones por 15 minutos
    message: {
      success: false,
      message: "Demasiadas peticiones, intenta más tarde",
    },
  },
  sendMessage: {
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 20, // 20 peticiones por 15 minutos
  },
  sendImage: {
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 30, // 30 peticiones por 15 minutos
  },
};



// Configuracion de WhatsApp
export const WHATSAPP_CONFIG = {
  authPath: "./auth_info",
  sessionName: "XIO CRM",
  qrTimeout: 120000,
  qrDisplayDuration: 20000,
  baileysVersionCacheMs: 24 * 60 * 60 * 1000,
  logoutTimeoutMs: 5000,
  maxImageSize: 2,
};
