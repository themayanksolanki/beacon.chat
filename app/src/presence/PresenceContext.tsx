import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

import { isUserBlocked } from "../db/database";
import { getSocket } from "../network/socket";

export interface PresenceInfo {
  online: boolean;
  lastSeenAt: number | null;
}

interface PresenceSnapshotEntry {
  userId: string;
  online: boolean;
  lastSeenAt: number | null;
}

interface PresenceContextValue {
  presence: Record<string, PresenceInfo>;
  subscribe: (userIds: string[]) => void;
}

const PresenceContext = createContext<PresenceContextValue>({
  presence: {},
  subscribe: () => {},
});

export function PresenceProvider({ children }: { children: ReactNode }) {
  const [presence, setPresence] = useState<Record<string, PresenceInfo>>({});
  const subscribedIds = useRef<Set<string>>(new Set());
  const listenerAttached = useRef(false);

  const applySnapshot = useCallback((snapshot: PresenceSnapshotEntry[]) => {
    setPresence((prev) => {
      const next = { ...prev };
      for (const entry of snapshot) {
        next[entry.userId] = { online: entry.online, lastSeenAt: entry.lastSeenAt };
      }
      return next;
    });
  }, []);

  const requestSnapshot = useCallback(
    (userIds: string[]) => {
      if (userIds.length === 0) return;
      getSocket().emit("presence:subscribe", { userIds }, applySnapshot);
    },
    [applySnapshot]
  );

  // Only called once subscribe() is first used, which only happens from
  // already-authenticated screens — by then the socket is guaranteed to exist.
  const ensureListeners = useCallback(() => {
    if (listenerAttached.current) return;
    listenerAttached.current = true;
    const socket = getSocket();

    socket.on(
      "presence:update",
      ({ userId, online, lastSeenAt }: { userId: string; online: boolean; lastSeenAt: number | null }) => {
        setPresence((prev) => ({ ...prev, [userId]: { online, lastSeenAt } }));
      }
    );

    // Room membership for presence:<id> lives on the server-side socket, so
    // a reconnect (network blip, app resume) silently drops it — resync
    // everything we care about whenever the transport reconnects.
    socket.on("connect", () => requestSnapshot(Array.from(subscribedIds.current)));
  }, [requestSnapshot]);

  const subscribe = useCallback(
    (userIds: string[]) => {
      ensureListeners();
      // Blocked peers never get a presence subscription — this is the single
      // choke point every screen's subscribe() call goes through, so it's
      // enough to keep a blocked user's online dot/last-seen from ever
      // appearing anywhere without each screen having to check separately.
      const unseen = userIds.filter((id) => id && !subscribedIds.current.has(id) && !isUserBlocked(id));
      if (unseen.length === 0) return;
      unseen.forEach((id) => subscribedIds.current.add(id));
      requestSnapshot(unseen);
    },
    [ensureListeners, requestSnapshot]
  );

  return <PresenceContext.Provider value={{ presence, subscribe }}>{children}</PresenceContext.Provider>;
}

export function usePresence(): PresenceContextValue {
  return useContext(PresenceContext);
}
