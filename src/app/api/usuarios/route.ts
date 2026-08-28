import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { requerirSesionDeNegocio, requerirRol } from "@/lib/tenant";
import { manejarErrorApi } from "@/lib/api-error";
import { leerBooleano } from "@/lib/http";

// MÓDULO 10 — Empleados (el mismo modelo Usuario, ver nota en schema.prisma).
const crearVendedorSchema = z.object({
  nombre: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  telefono: z.string().optional(),
  documento: z.string().optional(),
  cargo: z.string().optional(),
  fechaIngreso: z.string().optional(),
  salarioBase: z.number().nonnegative().optional(),
  metaVentasMensual: z.number().nonnegative().optional(),
});

const SELECT_PUBLICO = {
  id: true,
  nombre: true,
  email: true,
  rol: true,
  activo: true,
  telefono: true,
  documento: true,
  cargo: true,
  fechaIngreso: true,
  salarioBase: true,
  metaVentasMensual: true,
  createdAt: true,
} as const;

// GET /api/usuarios — lista los empleados del propio negocio.
export async function GET(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const activo = leerBooleano(req.nextUrl.searchParams.get("activo"));

    const usuarios = await prisma.usuario.findMany({
      where: { negocioId: sesion.negocioId, ...(activo !== undefined ? { activo } : {}) },
      select: SELECT_PUBLICO,
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({ usuarios });
  } catch (error) {
    return manejarErrorApi(error);
  }
}

// POST /api/usuarios — RF-004: crear vendedor. Sin límite en el MVP (RN-003).
export async function POST(req: NextRequest) {
  try {
    const sesion = await requerirSesionDeNegocio(req);
    requerirRol(sesion, "ADMINISTRADOR");
    const data = crearVendedorSchema.parse(await req.json());

    const existente = await prisma.usuario.findUnique({ where: { email: data.email } });
    if (existente) {
      return NextResponse.json({ error: "Ese correo ya está registrado" }, { status: 409 });
    }

    const passwordHash = await hashPassword(data.password);
    const vendedor = await prisma.usuario.create({
      data: {
        negocioId: sesion.negocioId,
        nombre: data.nombre,
        email: data.email,
        passwordHash,
        rol: "VENDEDOR",
        telefono: data.telefono,
        documento: data.documento,
        cargo: data.cargo,
        fechaIngreso: data.fechaIngreso ? new Date(data.fechaIngreso) : undefined,
        salarioBase: data.salarioBase,
        metaVentasMensual: data.metaVentasMensual,
      },
      select: SELECT_PUBLICO,
    });

    return NextResponse.json({ usuario: vendedor }, { status: 201 });
  } catch (error) {
    return manejarErrorApi(error);
  }
}
