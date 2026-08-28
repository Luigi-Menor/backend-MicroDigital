import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { verificarTokenGoogle } from "@/lib/google";
import { firmarSesion, SESSION_COOKIE_NAME, opcionesCookieSesion } from "@/lib/session";
import { manejarErrorApi } from "@/lib/api-error";

// Mismos datos de negocio que el registro clásico (RF-001), pero sin
// nombreAdmin/email/password: esos tres vienen verificados del token de
// Google en vez de que el usuario los escriba a mano.
const schema = z.object({
  credential: z.string().min(10),
  nombreNegocio: z.string().min(2, "El nombre del negocio es obligatorio"),
  tipoNegocio: z.string().min(2, "El tipo de negocio es obligatorio"),
  contacto: z.string().min(5, "El contacto es obligatorio"),
});

export async function POST(req: NextRequest) {
  try {
    const body = schema.parse(await req.json());
    const perfil = await verificarTokenGoogle(body.credential);

    const existente = await prisma.usuario.findUnique({ where: { email: perfil.email } });
    if (existente) {
      return NextResponse.json(
        {
          error: "Ya existe una cuenta con este correo de Google. Inicia sesión en vez de registrarte.",
          codigo: "CUENTA_YA_EXISTE",
        },
        { status: 409 }
      );
    }

    const { negocio, admin } = await prisma.$transaction(async (tx) => {
      const negocio = await tx.negocio.create({
        data: {
          nombre: body.nombreNegocio,
          tipoNegocio: body.tipoNegocio,
          contacto: body.contacto,
        },
      });
      const admin = await tx.usuario.create({
        data: {
          negocioId: negocio.id,
          nombre: perfil.nombre,
          email: perfil.email,
          googleId: perfil.googleId,
          rol: "ADMINISTRADOR",
        },
      });
      return { negocio, admin };
    });

    const token = await firmarSesion({
      usuarioId: admin.id,
      negocioId: negocio.id,
      rol: admin.rol,
      email: admin.email,
    });

    const res = NextResponse.json(
      { negocio: { id: negocio.id, nombre: negocio.nombre }, usuario: { id: admin.id, rol: admin.rol } },
      { status: 201 }
    );
    res.cookies.set(SESSION_COOKIE_NAME, token, opcionesCookieSesion());
    return res;
  } catch (error) {
    return manejarErrorApi(error);
  }
}
