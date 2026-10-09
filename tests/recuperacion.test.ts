import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, limpiarBD, reiniciarLimites, crearEscenario, llamar, CLAVE } from "./helpers";
import { hashToken } from "@/lib/hash-token";
import { verifyPassword } from "@/lib/password";
import * as recuperar from "@/app/api/auth/recuperar/route";
import * as confirmar from "@/app/api/auth/recuperar/confirmar/route";

// RF-007 / RF-008 / RNF-002 — recuperación de contraseña.
describe("Recuperación de contraseña", () => {
  let e: Awaited<ReturnType<typeof crearEscenario>>;

  beforeEach(async () => {
    await limpiarBD();
    reiniciarLimites();
    e = await crearEscenario();
  });

  /** Crea un enlace como lo haría el backend y devuelve el token crudo. */
  async function crearToken(usuarioId: string, minutos = 15) {
    const token = crypto.randomBytes(32).toString("hex");
    await prisma.passwordResetToken.create({
      data: { usuarioId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + minutos * 60_000) },
    });
    return token;
  }

  const confirmarCon = (token: string, password: string) =>
    llamar(confirmar.POST, { metodo: "POST", cuerpo: { token, password } });

  it("la respuesta es idéntica exista o no el correo", async () => {
    const existe = await llamar(recuperar.POST, { metodo: "POST", cuerpo: { email: e.a.admin.email } });
    const noExiste = await llamar(recuperar.POST, { metodo: "POST", cuerpo: { email: "nadie@test.local" } });
    expect(existe.status).toBe(200);
    expect(noExiste.status).toBe(200);
    expect(existe.body).toEqual(noExiste.body);
    // Esperar al trabajo en segundo plano antes de que la siguiente prueba limpie la base.
    await expect.poll(() => prisma.passwordResetToken.count(), { timeout: 5000 }).toBe(1);
  });

  it("solicitar un enlace guarda solo el hash del token y anula los anteriores", async () => {
    const anterior = await crearToken(e.a.admin.id);
    await llamar(recuperar.POST, { metodo: "POST", cuerpo: { email: e.a.admin.email } });
    // El trabajo ocurre fuera de la respuesta (para no filtrar por tiempo).
    await expect.poll(() => prisma.passwordResetToken.count({ where: { usuarioId: e.a.admin.id } }), { timeout: 5000 }).toBe(2);

    const vigentes = await prisma.passwordResetToken.findMany({ where: { usuarioId: e.a.admin.id, usado: false } });
    expect(vigentes).toHaveLength(1);
    expect(vigentes[0]!.tokenHash).toHaveLength(64); // sha256 en hex, nunca el token crudo
    expect((await confirmarCon(anterior, "NuevaClave123")).status).toBe(400);
  });

  it("PT-10: un enlace vigente cambia la contraseña y solo se puede usar una vez", async () => {
    const token = await crearToken(e.a.admin.id);
    expect((await confirmarCon(token, "NuevaClave123")).status).toBe(200);
    expect((await confirmarCon(token, "OtraClave456")).status).toBe(400);

    const usuario = await prisma.usuario.findUniqueOrThrow({ where: { id: e.a.admin.id } });
    expect(await verifyPassword("NuevaClave123", usuario.passwordHash!)).toBe(true);
    expect(await verifyPassword(CLAVE, usuario.passwordHash!)).toBe(false);
  });

  it("PT-10: un enlace vencido se rechaza", async () => {
    const token = await crearToken(e.a.admin.id, -1);
    expect((await confirmarCon(token, "NuevaClave123")).status).toBe(400);
  });

  it("una contraseña demasiado corta se rechaza sin gastar el enlace", async () => {
    const token = await crearToken(e.a.admin.id);
    expect((await confirmarCon(token, "corta")).status).toBe(400);
    expect((await confirmarCon(token, "NuevaClave123")).status).toBe(200);
  });

  it("RNF-002: dos confirmaciones simultáneas con el mismo enlace -> solo una gana", async () => {
    const token = await crearToken(e.a.admin.id);
    const resultados = await Promise.all([
      confirmarCon(token, "ClaveUno1234"),
      confirmarCon(token, "ClaveDos1234"),
      confirmarCon(token, "ClaveTres123"),
    ]);
    expect(resultados.filter((r) => r.status === 200)).toHaveLength(1);
    expect(resultados.filter((r) => r.status === 400)).toHaveLength(2);
  });
});
