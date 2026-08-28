import { OAuth2Client } from "google-auth-library";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

if (!GOOGLE_CLIENT_ID && process.env.NODE_ENV === "production") {
  throw new Error("NEXT_PUBLIC_GOOGLE_CLIENT_ID no está configurado.");
}

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

export interface PerfilGoogle {
  googleId: string;
  email: string;
  nombre: string;
}

export class ErrorTokenGoogle extends Error {}

/**
 * Verifica la firma, audiencia (`aud`) y emisor (`iss`) del ID token que
 * entrega el botón de Google (Google Identity Services). Nunca decodificar
 * el JWT manualmente para tomar decisiones de autenticación/autorización —
 * eso permitiría a cualquiera falsificar un token con `aud`/`email` a su
 * gusto. `google-auth-library` descarga y cachea las claves públicas de
 * Google y hace toda la verificación criptográfica.
 */
export async function verificarTokenGoogle(credential: string): Promise<PerfilGoogle> {
  if (!GOOGLE_CLIENT_ID) {
    throw new ErrorTokenGoogle("Google Sign-In no está configurado en el servidor");
  }

  let ticket;
  try {
    ticket = await client.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
  } catch {
    throw new ErrorTokenGoogle("Token de Google inválido o expirado");
  }

  const payload = ticket.getPayload();
  if (!payload || !payload.email) {
    throw new ErrorTokenGoogle("El token de Google no incluye un correo");
  }

  // Google advierte explícitamente: `email_verified` puede ser true incluso
  // si el dominio no es de Gmail/Workspace y Google no es "autoritativo"
  // sobre esa dirección. Para MVP igual lo exigimos como mínimo razonable;
  // documentado como decisión de seguridad en el README.
  if (!payload.email_verified) {
    throw new ErrorTokenGoogle("El correo de Google no está verificado");
  }

  return {
    googleId: payload.sub,
    email: payload.email,
    nombre: payload.name ?? payload.email.split("@")[0] ?? payload.email,
  };
}
