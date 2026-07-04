import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app";
import { createSocketServer } from "./socketServer";
import { initDatabase } from "./db";

initDatabase();

const app = createApp();
const httpServer = createServer(app);
createSocketServer(httpServer);

const PORT = process.env.PORT ?? 4000;
httpServer.listen(PORT, () => {
  console.log(`beacon server listening on :${PORT}`);
});
