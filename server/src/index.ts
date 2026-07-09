import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app";
import { createSocketServer } from "./socketServer";
import { initDatabase } from "./db";
import { connectMongo } from "./mongo";
import { startAccountDeletionSweep } from "./accountDeletion";
import { backfillAcceptedContactsFromMessages } from "./contacts";

initDatabase();
backfillAcceptedContactsFromMessages();
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
