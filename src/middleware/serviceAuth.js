import crypto from "crypto";
import logger from "../services/logger.service.js";

const SECRET = process.env.WHATSAPP_SERVICE_SECRET;
if (!SECRET || SECRET.length < 32) {
  throw new Error("WHATSAPP_SERVICE_SECRET no configurado (mín. 32 chars)");
}

// Hasheamos y recibe buffers de igual largo
const sha = (v) => crypto.createHash("sha256").update(v).digest();
const EXPECTED = sha(SECRET);

export function requireServiceSecret(req, res, next) {
  const provided = req.get("x-service-secret") || "";
  if (crypto.timingSafeEqual(sha(provided), EXPECTED)) return next();

  logger.warn("Acceso no autorizado al servicio WhatsApp", {
    ip: req.ip,
    path: req.originalUrl,
    method: req.method,
  });
  return res.sendStatus(401);
}

export function verifySocketToken(token) {
  if (typeof token !== "string") return false;
  const [exp, sig] = token.split(".");
  const expNum = Number(exp);
  if (!exp || !sig || !Number.isFinite(expNum) || expNum < Date.now() / 1000) {
    return false;
  }
  if (!/^[a-f0-9]{64}$/.test(sig)) return false; // HMAC-SHA256 en hex = 64 chars ASCII

  const expected = crypto.createHmac("sha256", SECRET).update(exp).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}