import { io, Socket } from "socket.io-client";

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL ?? "http://localhost:4000";

let socket: Socket | null = null;

export function connectSocket(authToken: string): Socket {
  if (socket?.connected) return socket;

  socket = io(SERVER_URL, {
    auth: { token: authToken },
  });

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
