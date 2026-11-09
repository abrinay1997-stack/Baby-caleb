import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Cada archivo de prueba arranca con la base vacía y le aplica las migraciones
// en orden, como lo hará `wrangler d1 migrations apply`. Si una migración está
// mal escrita, las pruebas no corren: es la misma puerta que producción.
await applyD1Migrations(env.DB, env.MIGRACIONES);
