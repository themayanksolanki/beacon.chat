import { PrismaClient } from "@prisma/client";

// One client per process — Prisma pools connections internally, so
// re-instantiating per request (as the old per-request SQLite handle
// implicitly encouraged) would exhaust Postgres connections instead.
export const prisma = new PrismaClient();
