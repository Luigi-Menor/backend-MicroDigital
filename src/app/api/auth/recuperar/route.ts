import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/hash-token";
import { manejarErrorApi } from "@/lib/api-error";

// RF-003 — El enlace de recuperación expira a los 15 minutos (valor confirmado
// en el levantamiento, P.: recuperación de contraseña).
const RESET_EXPIRES_MINUTES = Number(process.env.PASSWORD_RESET_EXPIRES_MINUTES ?? 15);

const schema = z.object({ email: z.string().email() });

export async function POST(req: NextRequest) {
  try {
    const { email } = schema.parse(await req.json());
    const usuario = await prisma.usuario.findUnique({ where: { email } });

    // Respuesta idéntica exista o no el usuario (no filtrar qué correos están registrados).
    if (usuario) {
      // El token crudo se envía por correo y NUNCA se persiste tal cual;
      // en la base de datos solo queda su hash (ver lib/hash-token.ts).
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + RESET_EXPIRES_MINUTES * 60_000);
      await prisma.passwordResetToken.create({
        data: { usuarioId: usuario.id, tokenHash: hashToken(token), expiresAt },
      });

      // TODO integración real de correo (ej. Resend/SendGrid). Por ahora se
      // deja registrado en el log del servidor para pruebas en desarrollo.
      console.log(`[RF-003] Enlace de recuperación para ${email}: /restablecer?token=${token}`);
    }

    return NextResponse.json({
      mensaje: "Si el correo existe, se envió un enlace de recuperación válido por 15 minutos.",
    });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
