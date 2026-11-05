import whatsappService from "../services/whatsapp.service.js";
import logger from "../services/logger.service.js";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import ipaddr from "ipaddr.js";
import { fileTypeFromBuffer } from "file-type";

// NO importar mysql aquí arriba
let pool = null;

// Función para obtener la conexión solo cuando se necesite

/**
 * Obtiene el estado de la conexión de WhatsApp y el QR
 */
export async function getStatus(req, res) {
  try {
    const status = whatsappService.getStatus();
    res.json(status);
  } catch (error) {
    logger.error("Error al obtener estado de WhatsApp", {
      error: error.message,
    });
    res.status(500).json({
      success: false,
      message: "Error al obtener el estado",
    });
  }
}

/**
 * Solicita un nuevo código QR
 */
export async function requestQR(req, res) {
  try {
    if (whatsappService.isReady) {
      return res.status(400).json({
        success: false,
        message: "WhatsApp ya está conectado",
      });
    }

    if (whatsappService.isInitializing) {
      return res.status(409).json({
        success: false,
        message: "Ya hay una operación en progreso",
      });
    }

    // Si no existe el socket, se inicializa
    if (!whatsappService.sock) {
      await whatsappService.initialize();
    } else {
      // Si existe, se destruye y reinicia
      await whatsappService.destroy();
      await whatsappService.initialize();
    }

    res.json({
      success: true,
      message: "Generando nuevo QR...",
    });
  } catch (error) {
    logger.error("Error al solicitar nuevo QR", { error: error.message });
    res.status(500).json({
      success: false,
      message: "Error al generar QR",
    });
  }
}

/**
 * Reinicia la sesión de WhatsApp
 */
export async function resetSession(req, res) {
  try {
    if (whatsappService.isInitializing) {
      return res.status(409).json({
        success: false,
        message: "Ya hay una operación de reseteo en progreso",
      });
    }

    await whatsappService.resetSession();

    res.json({
      success: true,
      message: "Sesión reseteada",
    });
  } catch (error) {
    logger.error("Error al resetear la sesión de WhatsApp", {
      error: error.message,
    });
    if (whatsappService.sock) {
      res.json({
        success: true,
        message: "Sesión reiniciada con advertencias. Generando QR...",
      });
    } else {
      res.status(500).json({
        success: false,
        message: "Error al reiniciar sesión",
      });
    }
  }
}

// Límites por archivo. express.json limita el cuerpo HTTP entrante;
// estos controles también protegen las descargas remotas y la decodificación.
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 15_000;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_MEDIA_BYTES / 3);
const ALLOWED_MEDIA_TYPES = new Set([
  // Imágenes
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/avif",
  "image/bmp", "image/tiff", "image/x-icon", "image/vnd.microsoft.icon",
  "image/heic", "image/heif",
  // Audio
  "audio/mpeg", "audio/ogg", "audio/opus", "audio/wav", "audio/x-wav",
  "audio/flac", "audio/mp4", "audio/aac", "audio/x-aac", "audio/midi",
  "audio/x-midi", "audio/webm", "audio/3gpp", "audio/amr",
  "audio/x-m4a", "audio/ogg; codecs=opus",
  // Video
  "video/mp4", "video/webm", "video/3gpp", "video/quicktime",
  "video/x-msvideo", "video/x-matroska", "video/mpeg",
  // Documento permitido
  "application/pdf",
]);

class MediaError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "MediaError";
    this.status = status;
  }
}

function isPublicIp(address) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

// Valida todas las respuestas DNS y conecta usando una de esas mismas IP.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
      return callback(new MediaError("Destino de descarga no permitido"));
    }
    const family = typeof options === "number" ? options : options.family;
    const candidates = family
      ? addresses.filter((entry) => entry.family === family)
      : addresses;
    if (!candidates.length) return callback(new MediaError("IP no disponible"));
    if (options.all) return callback(null, candidates);
    callback(null, candidates[0].address, candidates[0].family);
  });
}

async function downloadMedia(source) {
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new MediaError("URL inválida");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" || url.username || url.password ||
    (net.isIP(hostname) && !isPublicIp(hostname))
  ) throw new MediaError("URL de descarga no permitida");

  const signal = AbortSignal.timeout(MEDIA_TIMEOUT_MS);
  let response;
  try {
    response = await new Promise((resolve, reject) => {
      https.get(url, {
        agent: false,
        lookup: safeLookup,
        signal,
        rejectUnauthorized: true,
        maxHeaderSize: 16 * 1024,
        headers: { "Accept-Encoding": "identity" },
      }, resolve).on("error", reject);
    });
    // https.get no sigue redirecciones; se aceptan solamente respuestas 2xx.
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new MediaError("Descarga fallida o redirección no permitida");
    }
    const encoding = response.headers["content-encoding"];
    if (encoding && encoding.toLowerCase() !== "identity") {
      throw new MediaError("Respuesta HTTP comprimida no permitida");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > MAX_MEDIA_BYTES) {
        throw new MediaError("El archivo supera los 10 MB", 413);
      }
      chunks.push(chunk);
    }
    if (!response.complete || !size) {
      throw new MediaError("Archivo vacío o descarga incompleta");
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError(signal.aborted
      ? "La descarga superó los 15 segundos"
      : "No se pudo descargar el archivo");
  } finally {
    response?.destroy();
  }
}

function decodeMediaBase64(source) {
  let base64 = source;
  if (/^data:/i.test(source)) {
    const comma = source.indexOf(",");
    if (comma === -1) throw new MediaError("URL de datos inválida");
    base64 = source.slice(comma + 1);
  }
  if (base64.length > MAX_BASE64_LENGTH || Buffer.byteLength(base64, "base64") > MAX_MEDIA_BYTES) {
    throw new MediaError("El archivo supera los 10 MB", 413);
  }
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) {
    throw new MediaError("Archivo vacío");
  }
  return buffer;
}

/** Procesa HTTPS o Base64 limitado y devuelve el MIME detectado por los bytes. */
async function processMedia(mediaSource) {
  if (mediaSource == null || mediaSource === "") {
    return { buffer: null, mimetype: null };
  }
  if (typeof mediaSource !== "string") {
    throw new MediaError("La fuente de media debe ser una cadena");
  }

  const buffer = /^https?:\/\//i.test(mediaSource)
    ? await downloadMedia(mediaSource)
    : decodeMediaBase64(mediaSource);

  let type;
  try {
    type = await fileTypeFromBuffer(buffer);
  } catch {
    throw new MediaError("No se pudo reconocer el formato del archivo", 415);
  }
  if (!type || !ALLOWED_MEDIA_TYPES.has(type.mime)) {
    throw new MediaError("Formato de archivo no permitido", 415);
  }
  return { buffer, mimetype: type.mime };
}

/**
 * Alias para compatibilidad hacia atrás
 */
async function processImage(imageSource) {
  const media = await processMedia(imageSource);
  if (!media.buffer || !media.mimetype.startsWith("image/")) {
    throw new MediaError("La campaña requiere una imagen válida", 415);
  }
  return media;
}

/**
 * Envía campaña de WhatsApp (llamado desde Laravel)
 */
export async function sendCampaign(req, res) {
  try {
    if (!whatsappService.isReady) {
      return res.status(400).json({
        success: false,
        message: "WhatsApp no está conectado",
      });
    }

    const { phone, message, image, messages } = req.body;

    // Limpiar número
    const numberId = (
      phone ||
      (messages && messages[0] && messages[0].phone) ||
      ""
    ).replace(/\D/g, "");
    if (numberId.length < 10 || numberId.length > 15) {
      return res
        .status(400)
        .json({ success: false, message: "Número de teléfono no válido" });
    }
    const jid = await whatsappService.validateNumber(
      `${numberId}@s.whatsapp.net`,
    );
    if (!jid)
      return res
        .status(404)
        .json({ success: false, message: "Número no registrado" });

    // Función interna para enviar un mensaje individual
    const sendOne = async (msgText, msgImage) => {
      try {
        if (msgImage != null && msgImage !== "") {
          const { buffer, mimetype } = await processImage(msgImage);
          return await whatsappService.sendImage(
            jid,
            buffer,
            msgText,
            mimetype,
          );
        }
        return await whatsappService.sendMessage(jid, msgText);
      } catch (err) {
        logger.error("Error enviando mensaje individual en campaña", {
          error: err.message,
        });
        throw err;
      }
    };

    // Si viene un array de mensajes (Secuencia)
    if (Array.isArray(messages) && messages.length > 0) {
      // Enviamos respuesta inmediata para que Laravel no espere
      res.json({ success: true, message: "Secuencia de mensajes iniciada" });

      let currentDelay = 0;
      for (const msg of messages) {
        currentDelay += msg.delay || 0;
        setTimeout(async () => {
          try {
            await sendOne(msg.message, msg.image);
            logger.info("Mensaje de secuencia enviado", {
              phone: numberId,
              delay: msg.delay,
            });
          } catch (e) {
            logger.error("Fallo en mensaje de secuencia", { error: e.message });
          }
        }, currentDelay * 60000); // convertir minutos a ms
      }
      return;
    }

    // Si es un mensaje único (Tradicional)
    if (!message)
      return res
        .status(400)
        .json({ success: false, message: "Mensaje obligatorio" });

    const result = await sendOne(message, image);
    logger.info("Campaña única enviada correctamente", { phone: numberId });
    res.json(result);
  } catch (error) {
    logger.error("Error al enviar campaña de WhatsApp", {
      error: error.message,
    });
    if (res.headersSent) return;
    res.status(error instanceof MediaError ? error.status : 500).json({
      success: false,
      message: error instanceof MediaError
        ? error.message
        : "Error al enviar la campaña",
    });
  }
}

// Sincroniza mensajes (util para el n8n)
async function syncOutgoingMessageToCRM({
  jid,
  phone,
  message,
  messageId,
  timestamp,
}) {
  const crmUrl = process.env.CRM_URL || "http://localhost:3000";
  const secret = process.env.WHATSAPP_WEBHOOK_SECRET || "";

  const url = `${crmUrl}/api/whatsapp/outgoing`;

  const payload = {
    jid,
    phone,
    messageId,
    text: message,
    timestamp: new Date().toLocaleTimeString("es-PE", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
    sender: "agent",
    senderName: "Xiomara",
    channel: "whatsapp",
    source: "n8n",
    status: "sent",
  };

  console.log(
    "Sincronizando mensaje con CRM: hora registrada",
    payload.timestamp,
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": secret,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(`CRM respondió ${response.status}: ${errorText}`);
  }

  return await response.json();
}

/**
 * Envía mensaje genérico de texto (para CRM)
 */
export async function sendMessage(req, res) {
  try {
    if (!whatsappService.isReady) {
      return res.status(400).json({
        success: false,
        message: "WhatsApp no está conectado",
      });
    }

    const { phone, jid: inputJid, message, n8n: n8n } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        message: "El mensaje es obligatorio",
      });
    }

    let jid = null;

    // Si n8n/CRM ya conoce el JID real, lo preferimos.
    if (inputJid) {
      jid = await whatsappService.getJidForSending(inputJid);
    } else if (phone) {
      // LID
      if (String(phone).includes("@lid")) {
        jid = await whatsappService.getJidForSending(String(phone));
      } else {
        // Número telefónico
        const numberId = String(phone).replace(/\D/g, "");

        if (numberId.length < 10 || numberId.length > 15) {
          return res.status(400).json({
            success: false,
            message: "El formato del número de teléfono no es válido",
          });
        }

        jid = await whatsappService.getJidForSending(numberId);
      }
    } else {
      return res.status(400).json({
        success: false,
        message: "Se requiere jid o phone",
      });
    }

    if (!jid) {
      return res.status(404).json({
        success: false,
        message: "No se pudo resolver el destinatario de WhatsApp",
      });
    }

    // 1. Enviar primero a WhatsApp
    const result = await whatsappService.sendMessage(jid, message, {
      emitRealtime: n8n !== undefined,
    });

    // 2. Solo después de enviar correctamente,
    //    sincronizamos el mensaje con el CRM.
    if (n8n !== undefined) {
      try {
        await syncOutgoingMessageToCRM({
          jid,
          phone: phone || null,
          message,
          messageId: result.messageId,
          timestamp: result.timestamp,
        });
      } catch (crmError) {
        logger.error(
          "Mensaje de WhatsApp enviado, pero no se pudo sincronizar con CRM",
          {
            error: crmError.message,
            jid,
            messageId: result.messageId,
          },
        );
      }
    }

    return res.json(result);
  } catch (error) {
    logger.error("Error al enviar mensaje", {
      error: error.message,
    });

    return res.status(500).json({
      success: false,
      message: "Error al enviar el mensaje",
    });
  }
}

/**
 * Configura URL del webhook para mensajes entrantes
 */
export async function setupWebhook(req, res) {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: "La URL del webhook es obligatoria",
      });
    }

    // Validar URL
    try {
      new URL(url);
    } catch {
      return res.status(400).json({
        success: false,
        message: "La URL del webhook no es válida",
      });
    }

    whatsappService.setWebhookUrl(url);

    res.json({
      success: true,
      message: "Webhook configurado correctamente",
      url: url,
    });
  } catch (error) {
    logger.error("Error al configurar webhook", { error: error.message });
    res.status(500).json({
      success: false,
      message: "Error al configurar el webhook",
    });
  }
}

/**
 * Obtiene mensajes recibidos recientes
 */
export async function getReceivedMessages(req, res) {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const messages = whatsappService.getReceivedMessages(limit);

    res.json({
      success: true,
      messages: messages,
      total: messages.length,
    });
  } catch (error) {
    logger.error("Error al obtener mensajes recibidos", {
      error: error.message,
    });
    res.status(500).json({
      success: false,
      message: "Error al obtener los mensajes",
    });
  }
}

/**
 * Envía mensaje con media (imagen, audio, video, documento)
 * POST /api/whatsapp/send-media
 * Body: { phone, type, media, caption?, filename?, mimetype? }
 */
export async function sendMedia(req, res) {
  try {
    if (!whatsappService.isReady) {
      return res.status(400).json({
        success: false,
        message: "WhatsApp no está conectado",
      });
    }

    const {
      phone,
      type,
      media,
      caption,
      filename,
    } = req.body;

    if (!phone || !type || !media) {
      return res.status(400).json({
        success: false,
        message:
          "El teléfono, tipo de media y el contenido del media son obligatorios",
      });
    }

    const allowedTypes = ["image", "audio", "video", "document", "sticker"];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        message: `Tipo de media no válido. Permitidos: ${allowedTypes.join(", ")}`,
      });
    }

    // Resolver JID
    let jid;
    if (phone.includes("@lid")) {
      jid = await whatsappService.getJidForSending(phone);
    } else {
      const numberId = phone.replace(/\D/g, "");
      if (numberId.length < 10 || numberId.length > 15) {
        return res.status(400).json({
          success: false,
          message: "El formato del número de teléfono no es válido",
        });
      }
      jid = await whatsappService.getJidForSending(numberId);
    }

    if (!jid) {
      return res.status(404).json({
        success: false,
        message: "El número no está registrado en WhatsApp",
      });
    }

    // Procesar el media
    const { buffer, mimetype: detectedMimetype } = await processMedia(media);
    if (!buffer) {
      return res.status(400).json({
        success: false,
        message: "No se pudo procesar el archivo de media",
      });
    }

    const finalMimetype = detectedMimetype;
    const matchesType = type === "document" || (type === "sticker"
      ? finalMimetype === "image/webp"
      : finalMimetype.startsWith(`${type}/`));
    if (!matchesType) {
      throw new MediaError("El formato no corresponde al tipo de envío", 415);
    }

    // Enviar según el tipo
    let result;
    switch (type) {
      case "image":
        result = await whatsappService.sendImage(
          jid,
          buffer,
          caption || "",
          finalMimetype,
        );
        break;
      case "audio":
        result = await whatsappService.sendAudio(
          jid,
          buffer,
          finalMimetype,
        );
        break;
      case "video":
        result = await whatsappService.sendVideo(
          jid,
          buffer,
          caption || "",
          finalMimetype,
        );
        break;
      case "document":
        result = await whatsappService.sendDocument(
          jid,
          buffer,
          filename || "archivo",
          finalMimetype,
        );
        break;
      case "sticker":
        result = await whatsappService.sendSticker(
          jid,
          buffer,
          finalMimetype,
        );
        break;
    }

    logger.info("Media enviado correctamente", { phone, type, jid });
    res.json(result);
  } catch (error) {
    logger.error("Error al enviar media", { error: error.message });
    res.status(error instanceof MediaError ? error.status : 500).json({
      success: false,
      message: error instanceof MediaError
        ? error.message
        : "Error al enviar el archivo",
    });
  }
}
