import { beforeEach, describe, expect, it } from "vitest";
import { prisma, limpiarBD, reiniciarLimites, crearEscenario, cookieDe, llamar, CLAVE } from "./helpers";
import * as me from "@/app/api/auth/me/route";
import * as login from "@/app/api/auth/login/route";
import * as usuarios from "@/app/api/usuarios/route";
import * as usuarioId from "@/app/api/usuarios/[id]/route";
import * as ventaId from "@/app/api/ventas/[id]/route";
import * as ventas from "@/app/api/ventas/route";

// RNF-003 / RNF-004 / RN-004 / RNF-016 / RF-011
describe("Sesión, roles y usuarios", () => {
  let e: Awaited<ReturnType<typeof crearEscenario>>;

  beforeEach(async () => {
    await limpiarBD();
    reiniciarLimites();
    e = await crearEscenario();
  });

  it("sin sesión o con un token falsificado responde 401", async () => {
    expect((await llamar(me.GET)).status).toBe(401);
    expect((await llamar(me.GET, { cookie: "microdigital_session=eyJ.falso.token" })).status).toBe(401);
  });

  it("PT-03: un usuario desactivado pierde el acceso de inmediato, aunque su token siga vigente", async () => {
    const cookieV = await cookieDe(e.a.vendedor);
    expect((await llamar(me.GET, { cookie: cookieV })).status).toBe(200);
    await prisma.usuario.update({ where: { id: e.a.vendedor.id }, data: { activo: false } });
    expect((await llamar(me.GET, { cookie: cookieV })).status).toBe(401);
  });

  it("un administrador degradado pierde los permisos de administrador de inmediato", async () => {
    const otroAdmin = await prisma.usuario.create({
      data: { negocioId: e.a.negocio.id, nombre: "Admin 2", email: "admin2.a@test.local", rol: "ADMINISTRADOR", passwordHash: "x" },
    });
    const cookie2 = await cookieDe(otroAdmin);
    expect((await llamar(usuarios.GET, { cookie: cookie2 })).status).toBe(200);
    await prisma.usuario.update({ where: { id: otroAdmin.id }, data: { rol: "VENDEDOR" } });
    expect((await llamar(usuarios.GET, { cookie: cookie2 })).status).toBe(403);
  });

  it("PT-04: un vendedor no puede anular ventas", async () => {
    const cookieV = await cookieDe(e.a.vendedor);
    const venta = await llamar(ventas.POST, {
      metodo: "POST",
      cookie: cookieV,
      cuerpo: { formaPago: "EFECTIVO", items: [{ productoId: e.a.producto.id, cantidad: 1 }] },
    });
    expect(venta.status).toBe(201);
    const r = await llamar(ventaId.PUT, {
      metodo: "PUT",
      cookie: cookieV,
      params: { id: venta.body.venta.id },
      cuerpo: { accion: "ANULADA", motivo: "Prueba de permisos" },
    });
    expect(r.status).toBe(403);
  });

  it("PT-12 / RNF-016: el listado de usuarios no expone hashes ni identificadores de Google", async () => {
    const r = await llamar(usuarios.GET, { cookie: await cookieDe(e.a.admin) });
    expect(r.status).toBe(200);
    const texto = JSON.stringify(r.body);
    expect(texto).not.toContain("passwordHash");
    expect(texto).not.toContain("googleId");
  });

  it("RF-011: el administrador crea usuarios con rol; SUPERADMIN no es asignable", async () => {
    const cookieA = await cookieDe(e.a.admin);
    const admin = await llamar(usuarios.POST, {
      metodo: "POST",
      cookie: cookieA,
      cuerpo: { nombre: "Nueva Admin", email: "nueva.admin@test.local", password: CLAVE, rol: "ADMINISTRADOR" },
    });
    expect(admin.status).toBe(201);
    expect(admin.body.usuario.rol).toBe("ADMINISTRADOR");

    const porDefecto = await llamar(usuarios.POST, {
      metodo: "POST",
      cookie: cookieA,
      cuerpo: { nombre: "Nuevo Vend", email: "nuevo.vend@test.local", password: CLAVE },
    });
    expect(porDefecto.body.usuario.rol).toBe("VENDEDOR");

    const superadmin = await llamar(usuarios.POST, {
      metodo: "POST",
      cookie: cookieA,
      cuerpo: { nombre: "X", email: "x@test.local", password: CLAVE, rol: "SUPERADMIN" },
    });
    expect(superadmin.status).toBe(400);
  });

  it("RF-011: nadie puede quitarse su propio rol ni desactivarse a sí mismo", async () => {
    const cookieA = await cookieDe(e.a.admin);
    const rol = await llamar(usuarioId.PUT, {
      metodo: "PUT", cookie: cookieA, params: { id: e.a.admin.id }, cuerpo: { rol: "VENDEDOR" },
    });
    const activo = await llamar(usuarioId.PUT, {
      metodo: "PUT", cookie: cookieA, params: { id: e.a.admin.id }, cuerpo: { activo: false },
    });
    expect(rol.status).toBe(409);
    expect(activo.status).toBe(409);
    const tras = await prisma.usuario.findUniqueOrThrow({ where: { id: e.a.admin.id } });
    expect(tras.rol).toBe("ADMINISTRADOR");
    expect(tras.activo).toBe(true);
  });

  it("RF-011: un administrador no puede editar usuarios de otro negocio", async () => {
    const r = await llamar(usuarioId.PUT, {
      metodo: "PUT",
      cookie: await cookieDe(e.a.admin),
      params: { id: e.b.vendedor.id },
      cuerpo: { activo: false },
    });
    expect(r.status).toBe(404);
    expect((await prisma.usuario.findUniqueOrThrow({ where: { id: e.b.vendedor.id } })).activo).toBe(true);
  });

  it("PT-11: el login bloquea la fuerza bruta (429 tras 10 intentos por correo)", async () => {
    const estados: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await llamar(login.POST, {
        metodo: "POST",
        cuerpo: { email: e.a.admin.email, password: "incorrecta" },
      });
      estados.push(r.status);
    }
    expect(estados.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(estados[10]).toBe(429);
  });

  it("el login correcto emite una cookie httpOnly", async () => {
    const r = await llamar(login.POST, { metodo: "POST", cuerpo: { email: e.a.admin.email, password: CLAVE } });
    expect(r.status).toBe(200);
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("microdigital_session=");
    expect(cookie.toLowerCase()).toContain("httponly");
  });
});
