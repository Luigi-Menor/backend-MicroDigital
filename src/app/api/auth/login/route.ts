import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { firmarSesion, SESSION_COOKIE_NAME, opcionesCookieSesion } from "@/lib/session";
import { verifyPassword } from "@/lib/password";
import { manejarErrorApi } from "@/lib/api-error";

// RF-002 — Autenticación y redirección según rol (Superadmin / Admin / Vendedor).
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const { email, password } = loginSchema.parse(await req.json());

    const usuario = await prisma.usuario.findUnique({ where: { email } });
    // Mensaje genérico a propósito: no revelar si el correo existe o no.
    if (!usuario || !usuario.activo) {
      return NextResponse.json({ error: "Credenciales inválidas" }, { status: 401 });
    }

    // Cuenta creada solo vía Google (sin contraseña propia): no filtrar esto
    // con un mensaje distinto sería más "seguro" en teoría, pero aquí es
    // información que ya ayuda al usuario legítimo a desatascarse, y no
    // revela si la cuenta existe (eso ya lo sabe: acaba de intentar entrar
    // con ese correo).
    if (!usuario.passwordHash) {
      return NextResponse.json(
        { error: "Esta cuenta usa Google. Inicia sesión con el botón de Google." },
        { status: 401 }
      );
    }

    const passwordValido = await verifyPassword(password, usuario.passwordHash);
    if (!passwordValido) {
      return NextResponse.json({ error: "Credenciales inválidas" }, { status: 401 });
    }

    const token = await firmarSesion({
      usuarioId: usuario.id,
      negocioId: usuario.negocioId,
      rol: usuario.rol,
      email: usuario.email,
    });

    const res = NextResponse.json({
      usuario: { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol },
      // El frontend usa este campo para decidir a dónde redirigir:
      // SUPERADMIN -> /superadmin, ADMINISTRADOR/VENDEDOR -> /dashboard
      redirigirA: usuario.rol === "SUPERADMIN" ? "/superadmin" : "/dashboard",
    });
    res.cookies.set(SESSION_COOKIE_NAME, token, opcionesCookieSesion());
    return res;
  } catch (error) {
    return manejarErrorApi(error);
  }
}
