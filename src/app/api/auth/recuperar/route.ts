import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/hash-token";
import { manejarErrorApi } from "@/lib/api-error";
import { exigirLimite, ipDeCliente, LIMITES } from "@/lib/rate-limit";
import { correoConfigurado, correoRecuperacion, enviarCorreo } from "@/lib/correo";

// RF-003 — El enlace de recuperación expira a los 15 minutos (valor confirmado
// en el levantamiento, P.: recuperación de contraseña).
const RESET_EXPIRES_MINUTES = Number(process.env.PASSWORD_RESET_EXPIRES_MINUTES ?? 15);

const schema = z.object({ email: z.string().email() });

interface UsuarioRecuperable {
  id: string;
  email: string;
  nombre: string;
}

async function procesarSolicitud(usuario: UsuarioRecuperable): Promise<void> {
  // El token crudo se envía por correo y NUNCA se persiste tal cual; en la
  // base de datos solo queda su hash (ver lib/hash-token.ts).
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + RESET_EXPIRES_MINUTES * 60_000);
  await prisma.$transaction([
    // Un solo enlace vigente por usuario: al pedir otro, los anteriores dejan
    // de servir.
    prisma.passwordResetToken.updateMany({
      where: { usuarioId: usuario.id, usado: false },
      data: { usado: true },
    }),
    prisma.passwordResetToken.create({
      data: { usuarioId: usuario.id, tokenHash: hashToken(token), expiresAt },
    }),
  ]);

  const base = (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const enlace = `${base}/restablecer?token=${token}`;

  if (correoConfigurado()) {
    await enviarCorreo(
      correoRecuperacion({
        para: usuario.email,
        nombre: usuario.nombre,
        enlace,
        minutosValidez: RESET_EXPIRES_MINUTES,
      })
    );
  } else if (process.env.NODE_ENV !== "production") {
    // Solo desarrollo local sin Gmail configurado: el enlace queda en el log
    // del servidor para poder probar el flujo. En producción nunca se escribe
    // un token en los logs.
    console.log(`[recuperar] correo no configurado; enlace de ${usuario.email}: ${enlace}`);
  } else {
    console.error("[recuperar] correo no configurado: no se pudo enviar el enlace");
  }
}

export async function POST(req: NextRequest) {
  try {
    exigirLimite(
      `recuperar:ip:${ipDeCliente(req)}`,
      LIMITES.recuperarPorIp.maximo,
      LIMITES.recuperarPorIp.ventana
    );
    const { email } = schema.parse(await req.json());
    // Por correo además de por IP: evita inundar el buzón de una víctima
    // (y la tabla de tokens) rotando IPs.
    exigirLimite(
      `recuperar:correo:${email.toLowerCase()}`,
      LIMITES.recuperarPorCorreo.maximo,
      LIMITES.recuperarPorCorreo.ventana
    );
    const usuario = await prisma.usuario.findUnique({ where: { email } });

    // Respuesta idéntica exista o no el usuario (no filtrar qué correos están
    // registrados), TAMBIÉN en tiempo: todo el trabajo que solo ocurre cuando el
    // usuario existe (escribir el token, enviar el correo) se hace fuera de la
    // respuesta. Si se esperara, la diferencia de latencia delataría qué
    // correos están registrados. Un fallo se registra (sin token ni
    // credenciales) y el usuario puede volver a pedir el enlace.
    if (usuario && usuario.activo) {
      void procesarSolicitud(usuario).catch((error: unknown) => {
        console.error("[recuperar] fallo al procesar la solicitud:", (error as Error).message);
      });
    }

    return NextResponse.json({
      mensaje: `Si el correo existe, se envió un enlace de recuperación válido por ${RESET_EXPIRES_MINUTES} minutos.`,
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
