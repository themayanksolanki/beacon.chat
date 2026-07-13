import { Router } from "express";
import { requireAuth, type AuthedRequest } from "../auth";
import { createChatMediaUploadPost, isS3Configured, type ChatMediaKind } from "../s3";

export const mediaRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_MEDIA_KINDS: ChatMediaKind[] = ["image", "video", "file"];

// Issues a presigned S3 POST policy scoped to this user's own key prefix,
// keyed by the client-generated message id — the client uploads
// client-side-encrypted ciphertext directly to S3, never through this
// server (mirrors POST /profile/avatar/upload-url).
mediaRouter.post("/chat/upload-url", requireAuth, async (req: AuthedRequest, res) => {
  if (!isS3Configured()) {
    res.status(503).json({ error: "chat_media_upload_unavailable" });
    return;
  }

  const { messageId, kind } = req.body ?? {};
  if (typeof messageId !== "string" || !UUID_RE.test(messageId)) {
    res.status(400).json({ error: "invalid_message_id" });
    return;
  }
  if (typeof kind !== "string" || !CHAT_MEDIA_KINDS.includes(kind as ChatMediaKind)) {
    res.status(400).json({ error: "invalid_kind" });
    return;
  }

  const target = await createChatMediaUploadPost({
    senderId: req.user!.userId,
    messageId,
    kind: kind as ChatMediaKind,
  });
  res.json(target);
});
