import { AppState, type AppStateStatus } from "react-native";
import { io, Socket } from "socket.io-client";

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL ?? "http://localhost:4000";

let socket: Socket | null = null;
let appStateListenerAttached = false;

// Backgrounding suspends the OS-level TCP connection on both iOS and
// Android, so by the time the app is foregrounded again the socket is
// already dead — left alone, socket.io only notices on its own passive
// reconnection backoff (up to reconnectionDelayMax, 5s by default, since
// connectSocket below doesn't override it), during which presence,
// messages, and calls all sit stale. Forcing a reconnect attempt the
// instant the app becomes active skips that wait instead of just making it
// happen sooner on the next backoff tick. Attached once for the life of the
// app (mirrors socket itself being a module-level singleton) — reads the
// module-level `socket` binding fresh on every fire, so it stays correct
// across reconnectSocket/disconnectSocket reassigning it.
function attachAppStateReconnect() {
  if (appStateListenerAttached) return;
  appStateListenerAttached = true;
  AppState.addEventListener("change", (state: AppStateStatus) => {
    if (state === "active" && socket && !socket.connected) {
      socket.connect();
    }
  });
}

export function connectSocket(authToken: string): Socket {
  if (socket?.connected) return socket;

  socket = io(SERVER_URL, {
    auth: { token: authToken },
  });
  attachAppStateReconnect();

  return socket;
}

export function getSocket(): Socket {
  if (!socket) {
    throw new Error("Socket not connected. Call connectSocket() first.");
  }
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
