import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/session";

export async function POST() {
  const res = NextResponse.json({ mensaje: "Sesión cerrada" });
  // Debe borrarse con el mismo `domain` con el que se creó, o el navegador
  // no la reconoce como la misma cookie y la deja viva.
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    domain: process.env.COOKIE_DOMAIN || undefined,
    maxAge: 0,
  });
  return res;
}
