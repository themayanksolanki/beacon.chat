import { Router } from "express";
import { requireAuth, type AuthedRequest } from "../auth";

export const callsRouter = Router();

export interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

// Twilio's Network Traversal Service mints a fresh username/password (and
// STUN+TURN URLs) valid for a short TTL (currently 24h) per request — this
// is what lets the app avoid ever shipping a static, long-lived TURN
// credential in the bundle (anyone could pull that out of the APK/IPA and
// relay unlimited traffic through the account's TURN usage). Called
// server-side only; TWILIO_AUTH_TOKEN never reaches the client.
async function fetchTwilioIceServers(): Promise<IceServer[]> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("twilio_not_configured");
  }

  const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Tokens.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!res.ok) {
    throw new Error(`twilio_request_failed_${res.status}`);
  }

  const body = (await res.json()) as { ice_servers?: { urls?: string; url?: string; username?: string; credential?: string }[] };
  const servers = body.ice_servers ?? [];
  return servers
    .map((s) => ({ urls: s.urls ?? s.url ?? "", username: s.username, credential: s.credential }))
    .filter((s) => s.urls);
}

/**
 * Short-lived TURN (+ STUN) credentials for the calling feature — see
 * app/src/calls/CallContext.tsx, which fetches this fresh before creating
 * each call's peer connection rather than reading a static bundled value.
 */
callsRouter.get("/turn-credentials", requireAuth, async (_req: AuthedRequest, res) => {
  try {
    const iceServers = await fetchTwilioIceServers();
    res.json({ iceServers });
  } catch (err) {
    if (err instanceof Error && err.message === "twilio_not_configured") {
      res.status(503).json({ error: "turn_not_configured" });
      return;
    }
    console.error("[calls] failed to fetch TURN credentials", err);
    res.status(502).json({ error: "turn_unavailable" });
  }
});
