import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app";
import { createSocketServer } from "./socketServer";
import { startAccountDeletionSweep } from "./accountDeletion";
import { backfillAcceptedContactsFromMessages } from "./contacts";

// Schema is provisioned via `npm run prisma:migrate` (prod) /
// `npm run prisma:migrate:dev` (local) — Prisma migrations run as a
// separate CLI step, not at process startup like the old SQLite initDatabase().
//
// The contacts backfill is a one-time historical data migration (see
// backfillAcceptedContactsFromMessages doc comment), not a boot-time job —
// running it on every restart means re-scanning the full messages history
// on every deploy for no benefit past the first successful run. Opt into it
// once (e.g. for the deploy that first ships the contacts gate) via
// RUN_CONTACTS_BACKFILL=true, then leave it unset.
if (process.env.RUN_CONTACTS_BACKFILL === "true") {
  backfillAcceptedContactsFromMessages().catch((err) =>
    console.error("[contacts] backfill failed:", err)
  );
}
startAccountDeletionSweep();

const app = createApp();
const httpServer = createServer(app);
createSocketServer(httpServer);

const PORT = process.env.PORT ?? 4000;

httpServer.listen(PORT, () => {
  console.log(`beacon server listening on :${PORT}`);
});
