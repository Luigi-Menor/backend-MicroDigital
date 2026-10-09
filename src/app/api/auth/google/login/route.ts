import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { verificarTokenGoogle } from "@/lib/google";
import { firmarSesion, SESSION_COOKIE_NAME, opcionesCookieSesion } from "@/lib/session";
import { manejarErrorApi } from "@/lib/api-error";
import { exigirLimite, ipDeCliente, LIMITES } from "@/lib/rate-limit";

const schema = z.object({ credential: z.string().min(10) });

export async function POST(req: NextRequest) {
  try {
    exigirLimite(`login:ip:${ipDeCliente(req)}`, LIMITES.loginPorIp.maximo, LIMITES.loginPorIp.ventana);
    const { credential } = schema.parse(await req.json());
    const perfil = await verificarTokenGoogle(credential);

    let usuario = await prisma.usuario.findUnique({ where: { email: perfil.email } });

    if (!usuario) {
      return NextResponse.json(
        {
          error: "No existe una cuenta con este correo de Google. Regístrate primero.",
          codigo: "CUENTA_NO_EXISTE",
        },
        { status: 404 }
      );
    }
    if (!usuario.activo) {
      return NextResponse.json({ error: "Esta cuenta está desactivada" }, { status: 401 });
    }

    // Vincular la cuenta la primera vez que inicia sesión con Google, si
    // antes solo tenía correo/contraseña. El correo ya viene verificado por
    // Google (`email_verified`), así que este vínculo automático es seguro
    // en el sentido de que no requiere que el usuario pruebe nada más — es
    // una decisión de UX/seguridad documentada en el README.
    if (!usuario.googleId) {
      usuario = await prisma.usuario.update({
        where: { id: usuario.id },
        data: { googleId: perfil.googleId },
      });
    }

    const token = await firmarSesion({
      usuarioId: usuario.id,
      negocioId: usuario.negocioId,
      rol: usuario.rol,
      email: usuario.email,
    });

    const res = NextResponse.json({
      usuario: { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol },
      redirigirA: usuario.rol === "SUPERADMIN" ? "/superadmin" : "/dashboard",
    });
    res.cookies.set(SESSION_COOKIE_NAME, token, opcionesCookieSesion());
    return res;
  } catch (error) {
    return manejarErrorApi(error);
  }
}
