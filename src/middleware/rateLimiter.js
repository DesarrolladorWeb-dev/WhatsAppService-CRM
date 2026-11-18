import rateLimit from 'express-rate-limit';
import { RATE_LIMIT_CONFIG } from '../config/constants.js';

export const generalLimiter = rateLimit({
    windowMs: RATE_LIMIT_CONFIG.general.windowMs,
    max: RATE_LIMIT_CONFIG.general.max,
    message: RATE_LIMIT_CONFIG.general.message,
    standardHeaders: true,
    legacyHeaders: false
});

export const authLimiter = rateLimit({
    windowMs: RATE_LIMIT_CONFIG.auth.windowMs,
    max: RATE_LIMIT_CONFIG.auth.max,
    message: RATE_LIMIT_CONFIG.auth.message,
    skipSuccessfulRequests: true,
    // Solo cuentan los intentos no autorizados (401/403) y los errores de
    // servidor (5xx). Los 2xx y los 4xx de negocio (400, 404, 409, 415...)
    // no consumen cupo: son respuestas esperadas del CRM, no fuerza bruta.
    requestWasSuccessful: (_req, res) =>
        res.statusCode < 400 ||
        (res.statusCode < 500 && res.statusCode !== 401 && res.statusCode !== 403),
    standardHeaders: true,
    legacyHeaders: false
});

export const sendMessageLimiter = rateLimit({
    windowMs: RATE_LIMIT_CONFIG.sendMessage.windowMs,
    max: RATE_LIMIT_CONFIG.sendMessage.max,
    message: { success: false, message: 'Límite de mensajes alcanzado, espera un momento' },
    standardHeaders: true,
    legacyHeaders: false
});

export const sendImageLimiter = rateLimit({
    windowMs: RATE_LIMIT_CONFIG.sendImage.windowMs,
    max: RATE_LIMIT_CONFIG.sendImage.max,
    message: { success: false, message: 'Límite de imágenes alcanzado, espera un momento' },
    standardHeaders: true,
    legacyHeaders: false
});
