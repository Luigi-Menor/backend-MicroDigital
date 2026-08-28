# MicroDigital — Backend

API REST del proyecto MicroDigital. Next.js 14 (App Router) usado como
servidor de API puro — no sirve ninguna página, solo `route.ts`.

## Stack

PostgreSQL + Prisma · JWT (`jose`) en cookie httpOnly · `bcryptjs` ·
`google-auth-library` (verificación de Google Sign-In) · Zod

## Setup

```bash
npm install
docker compose up -d          # PostgreSQL local
cp .env.example .env
# Genera un JWT_SECRET propio:
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npx prisma generate
npx prisma migrate dev --name init
npm run prisma:seed           # opcional
npm run dev                   # http://localhost:4000
```

## Variables de entorno

Ver `.env.example`. Las más importantes:

- `DATABASE_URL` — PostgreSQL.
- `JWT_SECRET` — debe ser **idéntico** al del frontend (el frontend solo
  verifica el token, nunca lo firma).
- `FRONTEND_URL` — origen exacto permitido por CORS (ver `src/lib/cors.ts`).
- `COOKIE_DOMAIN` — opcional; solo si frontend/backend viven en subdominios
  distintos en producción (ver README raíz).
- `NEXT_PUBLIC_GOOGLE_CLIENT_ID` — mismo Client ID que el frontend.

## Estructura

```
prisma/schema.prisma     Modelo completo (RF-001 a RF-013)
prisma/seed.ts           Datos de prueba
src/lib/db.ts            Cliente Prisma (singleton)
src/lib/session.ts       Firma/verifica JWT (jose) + opcionesCookieSesion()
src/lib/password.ts      bcrypt — Node-only, nunca importar desde un middleware
src/lib/google.ts        Verificación del ID token de Google (google-auth-library)
src/lib/tenant.ts        Guardas de sesión y aislamiento multi-tenant
src/lib/cors.ts          Headers CORS (el frontend es otro origen)
src/middleware.ts        SOLO CORS — el control de acceso vive en cada route.ts
src/app/api/**           Endpoints REST
```

## Mapeo de requisitos → endpoint

| RF     | Endpoint                                              |
|--------|--------------------------------------------------------|
| RF-001 | `POST /api/auth/registro`                              |
| RF-001-B | `POST /api/auth/google/registro`                      |
| RF-002 | `POST /api/auth/login`                                  |
| RF-002-B | `POST /api/auth/google/login`                         |
| RF-003 | `POST /api/auth/recuperar`, `POST /api/auth/recuperar/confirmar` |
| RF-004 | `GET/POST /api/usuarios`, `PUT /api/usuarios/[id]`      |
| RF-005 | `GET /api/superadmin/negocios`                          |
| RF-006 | `GET/POST /api/categorias`                              |
| RF-007/RF-008 | `GET/POST /api/productos`, `PUT/DELETE /api/productos/[id]` |
| RF-009/RF-010 | `POST /api/ventas`                               |
| RF-011 | `PUT /api/ventas/[id]`                                  |
| RF-012 | `GET/POST /api/clientes`, `GET /api/clientes/[id]`      |
| RF-013 | `GET /api/dashboard`                                    |
| —      | `GET /api/auth/me` (usado por el frontend para leer la sesión) |

## Seguridad — decisiones ya resueltas

- **Aislamiento multi-tenant:** toda consulta operativa filtra por
  `negocioId` de la sesión (`src/lib/tenant.ts`).
- **Concurrencia en ventas:** descuento de stock con `updateMany` +
  `stock: { gte: cantidad }` dentro de una transacción (nunca "leer y luego
  decrementar").
- **`session.ts` (jose) separado de `password.ts` (bcrypt):** evita que una
  dependencia Node-only termine empaquetada en un middleware Edge.
- **Tokens de recuperación de contraseña:** se guarda `sha256(token)`, nunca
  el valor crudo.
- **Google Sign-In:** el ID token se verifica con `google-auth-library`
  (`verifyIdToken`), nunca decodificado a mano para tomar decisiones de
  autenticación.

## Pendiente

- RF-011: falta la edición real de ítems de una venta (hoy solo cambia el
  estado a `EDITADA`).
- Sin pruebas automatizadas ni rate limiting en login/recuperación.
- Sin paginación en `/api/ventas`, `/api/productos`, `/api/clientes`.
- Envío real de correo pendiente en RF-003 (hoy solo se loguea en consola).
