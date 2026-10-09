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

    const tokenHash = hashToken(token);
    const passwordHash = await hashPassword(password);

    // El enlace se consume con una sola escritura condicionada (no "leer y
    // luego marcar"): si dos peticiones llegan a la vez con el mismo enlace,
    // solo una encuentra `usado = false` y la otra recibe count = 0 (RNF-002:
    // un solo uso).
    const resultado = await prisma.$transaction(async (tx) => {
      const consumido = await tx.passwordResetToken.updateMany({
        where: { tokenHash, usado: false, expiresAt: { gt: new Date() } },
        data: { usado: true },
      });
      if (consumido.count === 0) return null;

      const registro = await tx.passwordResetToken.findUnique({ where: { tokenHash } });
      if (!registro) return null;

      await tx.usuario.update({ where: { id: registro.usuarioId }, data: { passwordHash } });
      // Cualquier otro enlace pendiente del usuario deja de servir.
      await tx.passwordResetToken.updateMany({
        where: { usuarioId: registro.usuarioId, usado: false },
        data: { usado: true },
      });
      return registro.usuarioId;
    });

    if (!resultado) {
      return NextResponse.json(
        {
          error: `El enlace es inválido o ya expiró (${process.env.PASSWORD_RESET_EXPIRES_MINUTES ?? 15} minutos de validez).`,
        },
        { status: 400 }
      );
    }

    return NextResponse.json({ mensaje: "Contraseña actualizada correctamente." });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
