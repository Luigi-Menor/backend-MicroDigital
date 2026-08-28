import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { firmarSesion, SESSION_COOKIE_NAME, opcionesCookieSesion } from "@/lib/session";
import { hashPassword } from "@/lib/password";
import { manejarErrorApi } from "@/lib/api-error";

// RF-001 — El sistema debe permitir que una persona registre un nuevo negocio
// proporcionando nombre, tipo de negocio y datos de contacto, creando
// automáticamente un usuario Administrador asociado a ese negocio.
const registroSchema = z.object({
  nombreNegocio: z.string().min(2, "El nombre del negocio es obligatorio"),
  tipoNegocio: z.string().min(2, "El tipo de negocio es obligatorio"),
  contacto: z.string().min(5, "El contacto es obligatorio"),
  nombreAdmin: z.string().min(2, "El nombre del administrador es obligatorio"),
  email: z.string().email("Correo inválido"),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres"),
});

export async function POST(req: NextRequest) {
  try {
    const body = registroSchema.parse(await req.json());

    const correoExistente = await prisma.usuario.findUnique({ where: { email: body.email } });
    if (correoExistente) {
      return NextResponse.json({ error: "Ese correo ya está registrado" }, { status: 409 });
    }

    const passwordHash = await hashPassword(body.password);

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
          nombre: body.nombreAdmin,
          email: body.email,
          passwordHash,
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
