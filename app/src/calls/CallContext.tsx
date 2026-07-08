import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Vibration } from "react-native";
import { StackActions } from "@react-navigation/native";
import * as Crypto from "expo-crypto";
import InCallManager from "react-native-incall-manager";
import {
  mediaDevices,
  MediaStream,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from "react-native-webrtc";

import { getConversationById, insertCall, updateCallOutcome, type CallKind, type CallStatus } from "../db/database";
import { getSocket } from "../network/socket";
import { useAuth } from "../auth/AuthContext";
import { dismissCallScreen, navigationRef } from "../navigation/navigationRef";

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
const RING_TIMEOUT_MS = 45000;

export type CallPhase =
  | "idle"
  | "outgoing-ringing"
  | "incoming-ringing"
  | "connecting"
  | "connected";

export interface CallInfo {
  callId: string;
  conversationId: string;
  peerName: string;
  kind: CallKind;
  direction: "outgoing" | "incoming";
}

interface IncomingInvite {
  callId: string;
  callerId: string;
  kind: CallKind;
  sdp: { type: string; sdp: string };
}

interface CallContextValue {
  phase: CallPhase;
  call: CallInfo | null;
  localStreamURL: string | null;
  remoteStreamURL: string | null;
  isMuted: boolean;
  isSpeakerOn: boolean;
  isCameraOff: boolean;
  callDurationSec: number;
  startCall: (conversationId: string, kind: CallKind) => Promise<void>;
  acceptIncomingCall: () => Promise<void>;
  rejectIncomingCall: () => void;
  endCall: () => void;
  toggleMute: () => void;
  toggleSpeaker: () => void;
  toggleCamera: () => void;
  switchCamera: () => void;
}

const CallContext = createContext<CallContextValue | null>(null);

export function CallProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();

  const [phase, setPhase] = useState<CallPhase>("idle");
  const [call, setCall] = useState<CallInfo | null>(null);
  const [localStreamURL, setLocalStreamURL] = useState<string | null>(null);
  const [remoteStreamURL, setRemoteStreamURL] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [callDurationSec, setCallDurationSec] = useState(0);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidatesRef = useRef<{ candidate: string; sdpMLineIndex: number | null; sdpMid: string | null }[]>(
    []
  );
  const remoteDescriptionSetRef = useRef(false);
  const incomingInviteRef = useRef<IncomingInvite | null>(null);
  const ringTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectedAtRef = useRef<number | null>(null);
  const callRef = useRef<CallInfo | null>(null);
  const phaseRef = useRef<CallPhase>("idle");

  useEffect(() => {
    callRef.current = call;
  }, [call]);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const clearRingTimeout = useCallback(() => {
    if (ringTimeoutRef.current) {
      clearTimeout(ringTimeoutRef.current);
      ringTimeoutRef.current = null;
    }
  }, []);

  const logCallOutcome = useCallback((status: CallStatus) => {
    const info = callRef.current;
    if (!info) return;
    const now = Date.now();
    if (phaseRef.current === "connected" || phaseRef.current === "connecting") {
      // A row was inserted as soon as the call started ringing (see
      // startCall/acceptIncomingCall) — this just fills in how it ended.
      updateCallOutcome(info.callId, status, connectedAtRef.current, now);
    } else {
      updateCallOutcome(info.callId, status, null, now);
    }
  }, []);

  const cleanup = useCallback(() => {
    clearRingTimeout();
    Vibration.cancel();
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    pendingCandidatesRef.current = [];
    remoteDescriptionSetRef.current = false;
    incomingInviteRef.current = null;
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
    connectedAtRef.current = null;
    InCallManager.stop();
    setLocalStreamURL(null);
    setRemoteStreamURL(null);
    setIsMuted(false);
    setIsSpeakerOn(false);
    setIsCameraOff(false);
    setCallDurationSec(0);
    setCall(null);
    setPhase("idle");
  }, [clearRingTimeout]);

  const flushPendingCandidates = useCallback(async (pc: RTCPeerConnection) => {
    const queued = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn("[call] failed to add queued ICE candidate", err);
      }
    }
  }, []);

  const createPeerConnection = useCallback(
    (callId: string) => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      // react-native-webrtc's RTCPeerConnection typings don't resolve cleanly
      // through Expo's "bundler" moduleResolution (event-target-shim's
      // package.json doesn't export the "/index" subpath its own .d.ts
      // imports) — addEventListener works fine at runtime, so cast around it.
      const events = pc as unknown as {
        addEventListener(type: "icecandidate", listener: (event: { candidate: RTCIceCandidate | null }) => void): void;
        addEventListener(type: "track", listener: (event: { streams: MediaStream[] }) => void): void;
        addEventListener(type: "connectionstatechange", listener: () => void): void;
      };

      events.addEventListener("icecandidate", (event) => {
        if (event.candidate) {
          getSocket().emit("call:ice-candidate", { callId, candidate: event.candidate.toJSON() });
        }
      });

      events.addEventListener("track", (event) => {
        const [stream] = event.streams;
        if (!stream) return;
        setRemoteStreamURL(stream.toURL());
        if (phaseRef.current !== "connected") {
          connectedAtRef.current = Date.now();
          setPhase("connected");
          durationIntervalRef.current = setInterval(() => {
            if (connectedAtRef.current) {
              setCallDurationSec(Math.floor((Date.now() - connectedAtRef.current) / 1000));
            }
          }, 1000);
        }
      });

      events.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          if (phaseRef.current !== "idle") {
            logCallOutcome(phaseRef.current === "connected" ? "completed" : "failed");
            dismissCallScreen();
            cleanup();
          }
        }
      });

      peerConnectionRef.current = pc;
      return pc;
    },
    [cleanup, logCallOutcome]
  );

  const startCall = useCallback(
    async (conversationId: string, kind: CallKind) => {
      if (phaseRef.current !== "idle") return;
      const conversation = getConversationById(conversationId);
      if (!conversation) return;

      const callId = Crypto.randomUUID();
      const info: CallInfo = {
        callId,
        conversationId,
        peerName: conversation.display_name ?? "Unknown",
        kind,
        direction: "outgoing",
      };
      setCall(info);
      setPhase("outgoing-ringing");
      if (navigationRef.isReady()) navigationRef.navigate("ActiveCall");

      insertCall({
        id: callId,
        conversation_id: conversationId,
        direction: "outgoing",
        kind,
        status: "missed",
        started_at: Date.now(),
        answered_at: null,
        ended_at: null,
      });

      try {
        const localStream = await mediaDevices.getUserMedia({
          audio: true,
          video: kind === "video" ? { facingMode: "user" } : false,
        });
        localStreamRef.current = localStream;
        setLocalStreamURL(localStream.toURL());
        InCallManager.start({ media: kind === "video" ? "video" : "audio" });

        const pc = createPeerConnection(callId);
        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        getSocket()
          .timeout(15000)
          .emit(
            "call:invite",
            { callId, calleeId: conversationId, kind, sdp: pc.localDescription!.toJSON() },
            (err: unknown, ack?: { ok: true } | { ok: false; error: string }) => {
              if (err || !ack?.ok) {
                logCallOutcome("failed");
                dismissCallScreen();
                cleanup();
              }
            }
          );

        ringTimeoutRef.current = setTimeout(() => {
          if (phaseRef.current === "outgoing-ringing") {
            getSocket().emit("call:end", { callId });
            logCallOutcome("missed");
            dismissCallScreen();
            cleanup();
          }
        }, RING_TIMEOUT_MS);
      } catch (err) {
        console.warn("[call] failed to start call", err);
        logCallOutcome("failed");
        dismissCallScreen();
        cleanup();
      }
    },
    [cleanup, createPeerConnection, logCallOutcome]
  );

  const handleInvite = useCallback((payload: IncomingInvite) => {
    if (phaseRef.current !== "idle") return; // server already prevents this via busy tracking, belt & suspenders
    const conversation = getConversationById(payload.callerId);
    incomingInviteRef.current = payload;

    const info: CallInfo = {
      callId: payload.callId,
      conversationId: payload.callerId,
      peerName: conversation?.display_name ?? "Unknown",
      kind: payload.kind,
      direction: "incoming",
    };
    setCall(info);
    setPhase("incoming-ringing");
    if (navigationRef.isReady()) navigationRef.navigate("IncomingCall");
    Vibration.vibrate([500, 1000, 500, 1000], true);

    insertCall({
      id: payload.callId,
      conversation_id: payload.callerId,
      direction: "incoming",
      kind: payload.kind,
      status: "missed",
      started_at: Date.now(),
      answered_at: null,
      ended_at: null,
    });

    ringTimeoutRef.current = setTimeout(() => {
      if (phaseRef.current === "incoming-ringing") {
        getSocket().emit("call:reject", { callId: payload.callId });
        logCallOutcome("missed");
        dismissCallScreen();
        cleanup();
      }
    }, RING_TIMEOUT_MS);
  }, [cleanup, logCallOutcome]);

  const acceptIncomingCall = useCallback(async () => {
    const invite = incomingInviteRef.current;
    if (!invite) return;
    clearRingTimeout();
    Vibration.cancel();
    setPhase("connecting");
    if (navigationRef.isReady()) {
      navigationRef.dispatch(StackActions.replace("ActiveCall"));
    }

    try {
      const localStream = await mediaDevices.getUserMedia({
        audio: true,
        video: invite.kind === "video" ? { facingMode: "user" } : false,
      });
      localStreamRef.current = localStream;
      setLocalStreamURL(localStream.toURL());
      InCallManager.start({ media: invite.kind === "video" ? "video" : "audio" });

      const pc = createPeerConnection(invite.callId);
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

      await pc.setRemoteDescription(new RTCSessionDescription(invite.sdp));
      remoteDescriptionSetRef.current = true;
      await flushPendingCandidates(pc);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      getSocket().emit("call:answer", { callId: invite.callId, sdp: pc.localDescription!.toJSON() });
    } catch (err) {
      console.warn("[call] failed to accept call", err);
      getSocket().emit("call:end", { callId: invite.callId });
      logCallOutcome("failed");
      dismissCallScreen();
      cleanup();
    }
  }, [cleanup, clearRingTimeout, createPeerConnection, flushPendingCandidates, logCallOutcome]);

  const rejectIncomingCall = useCallback(() => {
    const invite = incomingInviteRef.current;
    if (!invite) return;
    getSocket().emit("call:reject", { callId: invite.callId });
    logCallOutcome("declined");
    dismissCallScreen();
    cleanup();
  }, [cleanup, logCallOutcome]);

  const endCall = useCallback(() => {
    const info = callRef.current;
    if (!info) return;
    getSocket().emit("call:end", { callId: info.callId });
    logCallOutcome(phaseRef.current === "connected" ? "completed" : "missed");
    dismissCallScreen();
    cleanup();
  }, [cleanup, logCallOutcome]);

  const handleAnswer = useCallback(
    async (payload: { callId: string; sdp: { type: string; sdp: string } }) => {
      const pc = peerConnectionRef.current;
      if (!pc || callRef.current?.callId !== payload.callId) return;
      clearRingTimeout();
      setPhase("connecting");
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        remoteDescriptionSetRef.current = true;
        await flushPendingCandidates(pc);
      } catch (err) {
        console.warn("[call] failed to apply answer", err);
      }
    },
    [clearRingTimeout, flushPendingCandidates]
  );

  const handleRemoteIceCandidate = useCallback(
    async (payload: { callId: string; candidate: { candidate: string; sdpMLineIndex: number | null; sdpMid: string | null } }) => {
      if (callRef.current?.callId !== payload.callId) return;
      const pc = peerConnectionRef.current;
      if (pc && remoteDescriptionSetRef.current) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } catch (err) {
          console.warn("[call] failed to add ICE candidate", err);
        }
      } else {
        pendingCandidatesRef.current.push(payload.candidate);
      }
    },
    []
  );

  const handleRemoteEnd = useCallback(
    (payload: { callId: string; reason: string }) => {
      if (callRef.current?.callId !== payload.callId) return;
      const status: CallStatus =
        payload.reason === "rejected" ? "declined" : phaseRef.current === "connected" ? "completed" : "missed";
      logCallOutcome(status);
      dismissCallScreen();
      cleanup();
    },
    [cleanup, logCallOutcome]
  );

  useEffect(() => {
    if (!token) return;
    const socket = getSocket();
    socket.on("call:invite", handleInvite);
    socket.on("call:answer", handleAnswer);
    socket.on("call:ice-candidate", handleRemoteIceCandidate);
    socket.on("call:end", handleRemoteEnd);
    return () => {
      socket.off("call:invite", handleInvite);
      socket.off("call:answer", handleAnswer);
      socket.off("call:ice-candidate", handleRemoteIceCandidate);
      socket.off("call:end", handleRemoteEnd);
    };
  }, [token, handleInvite, handleAnswer, handleRemoteIceCandidate, handleRemoteEnd]);

  const toggleMute = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setIsMuted(!track.enabled);
  }, []);

  const toggleSpeaker = useCallback(() => {
    setIsSpeakerOn((prev) => {
      const next = !prev;
      InCallManager.setForceSpeakerphoneOn(next);
      return next;
    });
  }, []);

  const toggleCamera = useCallback(() => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setIsCameraOff(!track.enabled);
  }, []);

  const switchCamera = useCallback(() => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    // _switchCamera is a react-native-webrtc extension, not part of the spec typings.
    (track as unknown as { _switchCamera?: () => void })?._switchCamera?.();
  }, []);

  const value = useMemo<CallContextValue>(
    () => ({
      phase,
      call,
      localStreamURL,
      remoteStreamURL,
      isMuted,
      isSpeakerOn,
      isCameraOff,
      callDurationSec,
      startCall,
      acceptIncomingCall,
      rejectIncomingCall,
      endCall,
      toggleMute,
      toggleSpeaker,
      toggleCamera,
      switchCamera,
    }),
    [
      phase,
      call,
      localStreamURL,
      remoteStreamURL,
      isMuted,
      isSpeakerOn,
      isCameraOff,
      callDurationSec,
      startCall,
      acceptIncomingCall,
      rejectIncomingCall,
      endCall,
      toggleMute,
      toggleSpeaker,
      toggleCamera,
      switchCamera,
    ]
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) {
    throw new Error("useCall must be used within a CallProvider");
  }
  return ctx;
}
