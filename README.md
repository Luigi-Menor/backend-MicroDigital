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

## Pruebas automáticas

Pruebas de integración con [Vitest](https://vitest.dev) contra una PostgreSQL
**real** (`tests/`). Cubren lo que el SRS marca como crítico y no se puede
verificar con mocks:

| Archivo | Qué protege |
|---|---|
| `aislamiento.test.ts` | RNF-005 / RN-025: ningún negocio lee ni enlaza datos de otro |
| `sesion-y-roles.test.ts` | RNF-004 / RN-004 / RF-011: sesión revalidada, roles, fuerza bruta |
| `concurrencia.test.ts` | RNF-007: stock sin negativos, consecutivos sin duplicados, idempotencia |
| `integridad.test.ts` | RNF-006: rollback de la venta, fiados, anulaciones, compras |
| `recuperacion.test.ts` | RF-007 / RF-008 / RNF-002: enlace de un solo uso, vencimiento |

```bash
# Una sola vez: crear la base de pruebas (mismo servidor que la de desarrollo)
psql -U <usuario> -c "CREATE DATABASE solobackend_test;"

npm test            # corre todo una vez
npm run test:watch  # modo observación
```

La base de pruebas es `DATABASE_URL_TEST` o, si no está definida, la de
`DATABASE_URL` con `_test` añadido al nombre. **Las pruebas se niegan a
correr si el nombre de la base no termina en `_test`**, porque vacían las
tablas antes de cada caso. Antes de empezar aplican las migraciones con
`prisma migrate deploy` sobre esa base, así que también verifican que las
migraciones funcionen desde cero.

CI (`.github/workflows/ci.yml`) ejecuta en cada push y pull request:
`typecheck`, pruebas (con su propio PostgreSQL) y `next build`.

## Migraciones: corrección de orden (octubre 2026)

La migración `20260827120000_modulos_completos` tenía fecha **anterior** a
`20260828020715_init` aunque depende de ella. En una base nueva Prisma la
aplicaba primero y fallaba (`no existe el tipo «FormaPago»`). Se renombró a
`20260828030000_modulos_completos` (mismo contenido, mismo checksum).

Si una base ya tenía aplicadas las migraciones con el nombre viejo,
`prisma migrate status` mostrará una migración "no encontrada localmente" y
otra "pendiente". Se corrige actualizando solo el registro de control (no
toca datos ni tablas):

```sql
UPDATE "_prisma_migrations"
SET migration_name = '20260828030000_modulos_completos'
WHERE migration_name = '20260827120000_modulos_completos';
```

## Pendiente

- RF-044: falta la edición real de ítems de una venta (hoy solo cambia el
  estado a `EDITADA`).
- Auditoría general de operaciones sensibles (RNF-008), procedimiento de
  copias de seguridad (RNF-014) y logs estructurados (RNF-015).
- El límite de intentos vive en memoria: con más de una instancia del backend
  hay que moverlo a Redis.
