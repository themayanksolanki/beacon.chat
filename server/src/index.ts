import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app";
import { createSocketServer } from "./socketServer";
import { connectMongo } from "./mongo";
import { startAccountDeletionSweep } from "./accountDeletion";
import { backfillAcceptedContactsFromMessages } from "./contacts";

// Schema is provisioned via `npm run prisma:migrate` (prod) /
// `npm run prisma:migrate:dev` (local) — Prisma migrations run as a
// separate CLI step, not at process startup like the old SQLite initDatabase().
backfillAcceptedContactsFromMessages().catch((err) =>
  console.error("[contacts] backfill failed:", err)
);
startAccountDeletionSweep();

const app = createApp();
const httpServer = createServer(app);
createSocketServer(httpServer);

const PORT = process.env.PORT ?? 4000;

connectMongo()
  .catch((err) => console.error("[mongo] connection failed, profile sync disabled:", err))
  .finally(() => {
    httpServer.listen(PORT, () => {
      console.log(`beacon server listening on :${PORT}`);
    });
  });
