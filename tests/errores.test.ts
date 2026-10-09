import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { limpiarBD, crearEscenario } from "./helpers";
import { manejarErrorApi } from "@/lib/api-error";
import { ejecutarIdempotente } from "@/lib/idempotencia";

const errorPrisma = (code: string) =>
  new Prisma.PrismaClientKnownRequestError(`error simulado ${code}`, { code, clientVersion: Prisma.prismaVersion.client });

describe("Manejo de errores", () => {
  it("los errores transitorios de la base responden 503 reintentable, no 400", async () => {
    for (const code of ["P2024", "P2028", "P2034"]) {
      const r = manejarErrorApi(errorPrisma(code));
      expect(r.status).toBe(503);
      expect(r.headers.get("Retry-After")).toBe("1");
    }
  });

  it("los errores que sí dependen de la petición conservan su código", async () => {
    expect(manejarErrorApi(errorPrisma("P2002")).status).toBe(409); // duplicado
    expect(manejarErrorApi(errorPrisma("P2025")).status).toBe(404); // no existe
  });

  it("la respuesta no expone el mensaje interno del driver", async () => {
    const r = manejarErrorApi(errorPrisma("P2028"));
    expect(JSON.stringify(await r.json())).not.toContain("error simulado");
  });
});

describe("Idempotencia ante fallos transitorios", () => {
  let negocioId: string;

  beforeEach(async () => {
    await limpiarBD();
    negocioId = (await crearEscenario()).a.negocio.id;
  });

  const peticion = () =>
    new NextRequest("http://localhost:4000/api/ventas", {
      method: "POST",
      headers: { "Idempotency-Key": "reintento-tras-saturacion" },
    });

  it("un 503 no se guarda: el reintento con la misma clave se ejecuta de verdad", async () => {
    let ejecuciones = 0;
    const operacion = async () => {
      ejecuciones += 1;
      if (ejecuciones === 1) return manejarErrorApi(errorPrisma("P2028")); // base saturada
      return NextResponse.json({ ok: true }, { status: 201 });
    };

    const primera = await ejecutarIdempotente(peticion(), { negocioId, endpoint: "POST /api/ventas" }, operacion);
    const segunda = await ejecutarIdempotente(peticion(), { negocioId, endpoint: "POST /api/ventas" }, operacion);

    expect(primera.status).toBe(503);
    expect(segunda.status).toBe(201);
    expect(ejecuciones).toBe(2);
  });

  it("un 4xx sí se guarda: el reintento recibe la misma respuesta sin ejecutarse", async () => {
    let ejecuciones = 0;
    const operacion = async () => {
      ejecuciones += 1;
      return NextResponse.json({ error: "Stock insuficiente" }, { status: 409 });
    };
    await ejecutarIdempotente(peticion(), { negocioId, endpoint: "POST /api/ventas" }, operacion);
    const segunda = await ejecutarIdempotente(peticion(), { negocioId, endpoint: "POST /api/ventas" }, operacion);
    expect(segunda.status).toBe(409);
    expect(segunda.headers.get("Idempotent-Replay")).toBe("true");
    expect(ejecuciones).toBe(1);
  });
});
