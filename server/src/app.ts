import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { authRouter } from "./routes/auth";
import { usersRouter } from "./routes/users";
import { profileRouter } from "./routes/profile";

export function createApp() {
  const app = express();

  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(cors());
  // Default 100kb is too small for base64-encoded avatar photos.
  app.use(express.json({ limit: "5mb" }));
  app.use(rateLimit({ windowMs: 60_000, max: 100 }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/auth", authRouter);
  app.use("/users", usersRouter);
  app.use("/profile", profileRouter);

  return app;
}
