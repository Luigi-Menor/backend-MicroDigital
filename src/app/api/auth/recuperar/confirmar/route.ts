import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { hashToken } from "@/lib/hash-token";
import { manejarErrorApi } from "@/lib/api-error";
import { exigirLimite, ipDeCliente, LIMITES } from "@/lib/rate-limit";

const schema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres"),
});

export async function POST(req: NextRequest) {
  try {
    exigirLimite(
      `confirmar:ip:${ipDeCliente(req)}`,
      LIMITES.confirmarPorIp.maximo,
      LIMITES.confirmarPorIp.ventana
    );
    const { token, password } = schema.parse(await req.json());

    const registro = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!registro || registro.usado || registro.expiresAt < new Date()) {
      return NextResponse.json(
        { error: "El enlace es inválido o ya expiró (15 minutos de validez)." },
        { status: 400 }
      );
    }

    const passwordHash = await hashPassword(password);
    await prisma.$transaction([
      prisma.usuario.update({ where: { id: registro.usuarioId }, data: { passwordHash } }),
      prisma.passwordResetToken.update({ where: { id: registro.id }, data: { usado: true } }),
    ]);

    return NextResponse.json({ mensaje: "Contraseña actualizada correctamente." });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
