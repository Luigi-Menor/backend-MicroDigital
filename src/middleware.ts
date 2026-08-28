import { NextRequest, NextResponse } from "next/server";
import { aplicarCors } from "@/lib/cors";

// Este middleware NO decide autenticación/autorización — eso es
// responsabilidad exclusiva de cada route.ts (requerirSesion,
// requerirSesionDeNegocio, requerirRol en src/lib/tenant.ts). Mezclar
// control de acceso en el middleware fue justamente el patrón detrás de
// CVE-2025-29927 (bypass de autorización en middleware de Next.js); aquí el
// middleware solo agrega encabezados CORS.
export const config = {
  matcher: ["/api/:path*"],
};

export function middleware(req: NextRequest) {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return aplicarCors(new NextResponse(null, { status: 204 }), origin);
  }

  return aplicarCors(NextResponse.next(), origin);
}
