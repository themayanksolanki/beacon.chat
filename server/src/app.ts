import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { authRouter } from "./routes/auth";
import { usersRouter } from "./routes/users";
import { profileRouter } from "./routes/profile";
import { mediaRouter } from "./routes/media";
import { devicesRouter } from "./routes/devices";
import { callsRouter } from "./routes/calls";

export function createApp() {
  const app = express();

  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(cors());
  // Avatar photos go direct-to-S3 via presigned upload, not through JSON
  // bodies, so the default 100kb limit just needs a little headroom.
  app.use(express.json({ limit: "256kb" }));
  app.use(rateLimit({ windowMs: 60_000, max: 100 }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/auth", authRouter);
  app.use("/users", usersRouter);
  app.use("/profile", profileRouter);
  app.use("/media", mediaRouter);
  app.use("/devices", devicesRouter);
  app.use("/calls", callsRouter);

  return app;
}
