import nodemailer, { type Transporter } from "nodemailer";

/**
 * Envío de correo desde una cuenta de Gmail (la misma cuenta de Google del
 * proyecto) por SMTP con una "contraseña de aplicación".
 *
 * Configuración (backend/.env):
 *   GMAIL_USER          cuenta que envía, ej. tunegocio@gmail.com
 *   GMAIL_APP_PASSWORD  contraseña de aplicación de 16 caracteres. NO es la
 *                       contraseña de la cuenta: se genera en
 *                       myaccount.google.com/apppasswords y exige tener la
 *                       verificación en dos pasos activa.
 *   CORREO_REMITENTE    opcional, nombre visible. Por defecto "MicroDigital".
 *
 * Límites de Gmail a tener en cuenta: unas 500 destinatarios por día en una
 * cuenta personal (2000 en Google Workspace) y el remitente real siempre es
 * GMAIL_USER. Es adecuado para recuperación de contraseña y comprobantes a
 * bajo volumen; si el volumen crece conviene un proveedor transaccional
 * (Resend, SendGrid...) cambiando solo este archivo.
 */

export class ErrorCorreo extends Error {}

export interface MensajeCorreo {
  para: string;
  asunto: string;
  texto: string;
  html?: string;
}

const globalCorreo = globalThis as unknown as { transporteCorreo?: Transporter };

export function correoConfigurado(): boolean {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

function obtenerTransporte(): Transporter {
  if (!globalCorreo.transporteCorreo) {
    globalCorreo.transporteCorreo = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        // Gmail muestra la contraseña de aplicación con espacios; se aceptan
        // pegada tal cual.
        pass: (process.env.GMAIL_APP_PASSWORD ?? "").replace(/\s+/g, ""),
      },
    });
  }
  return globalCorreo.transporteCorreo;
}

/**
 * Envía un correo. Lanza `ErrorCorreo` si no hay credenciales configuradas o
 * si Gmail rechaza el envío. El mensaje de error nunca incluye credenciales.
 */
export async function enviarCorreo(mensaje: MensajeCorreo): Promise<void> {
  if (!correoConfigurado()) {
    throw new ErrorCorreo(
      "El envío de correo no está configurado (faltan GMAIL_USER y GMAIL_APP_PASSWORD)"
    );
  }

  const nombre = (process.env.CORREO_REMITENTE ?? "MicroDigital").replace(/["<>\r\n]/g, "");
  try {
    await obtenerTransporte().sendMail({
      from: `"${nombre}" <${process.env.GMAIL_USER}>`,
      to: mensaje.para,
      subject: mensaje.asunto,
      text: mensaje.texto,
      html: mensaje.html,
    });
  } catch (error) {
    // Se reinicia el transporte por si la conexión quedó en mal estado, y se
    // relanza un error genérico: el de nodemailer puede traer datos de la
    // sesión SMTP.
    globalCorreo.transporteCorreo = undefined;
    const codigo = (error as { code?: string; responseCode?: number }).code;
    throw new ErrorCorreo(`No se pudo enviar el correo${codigo ? ` (${codigo})` : ""}`);
  }
}

/** Escapa texto de usuario antes de incrustarlo en HTML de correo. */
export function escaparHtml(valor: string): string {
  return valor
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plantilla del correo de recuperación de contraseña. */
export function correoRecuperacion(params: {
  para: string;
  nombre: string;
  enlace: string;
  minutosValidez: number;
}): MensajeCorreo {
  const nombre = escaparHtml(params.nombre);
  const enlace = escaparHtml(params.enlace);
  return {
    para: params.para,
    asunto: "Recupera tu contraseña de MicroDigital",
    texto:
      `Hola ${params.nombre},\n\n` +
      `Recibimos una solicitud para restablecer tu contraseña. Abre este enlace ` +
      `(válido por ${params.minutosValidez} minutos y de un solo uso):\n\n${params.enlace}\n\n` +
      `Si no fuiste tú, ignora este mensaje: tu contraseña no cambiará.`,
    html:
      `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1f2937">` +
      `<h2 style="margin:0 0 12px">Recupera tu contraseña</h2>` +
      `<p>Hola ${nombre},</p>` +
      `<p>Recibimos una solicitud para restablecer tu contraseña. El enlace es válido ` +
      `por <b>${params.minutosValidez} minutos</b> y solo puede usarse una vez.</p>` +
      `<p style="margin:24px 0"><a href="${enlace}" style="background:#0f766e;color:#fff;` +
      `padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">` +
      `Restablecer contraseña</a></p>` +
      `<p style="font-size:13px;color:#6b7280">Si el botón no funciona, copia este enlace en el ` +
      `navegador:<br>${enlace}</p>` +
      `<p style="font-size:13px;color:#6b7280">Si no fuiste tú, ignora este mensaje: tu ` +
      `contraseña no cambiará.</p></div>`,
  };
}
