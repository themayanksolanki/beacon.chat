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
import { Alert, Platform, Vibration } from "react-native";
import { StackActions } from "@react-navigation/native";
import * as Crypto from "expo-crypto";
import InCallManager from "react-native-incall-manager";
import RNCallKeep, { CONSTANTS as CK_CONSTANTS } from "react-native-callkeep";
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
// Some environments (e.g. Android with a self-managed phone account the user
// hasn't authorized yet) accept RNCallKeep.startCall() without ever firing
// didReceiveStartCallAction — this bounds how long we wait for it before
// falling back to placing the call directly, same as the try/catch below.
const CALLKEEP_START_TIMEOUT_MS = 4000;

// The concrete signal that the camera/mic hardware is already held by
// another app or call (WhatsApp, a cellular call, etc.) rather than some
// other getUserMedia failure (permission denied, no such device, ...).
function isMediaBusyError(err: unknown): boolean {
  const name = (err as { name?: string } | null | undefined)?.name;
  return name === "NotReadableError" || name === "TrackStartError";
}

const MEDIA_BUSY_MESSAGE = "Your camera or microphone is already in use by another call. End that call and try again.";

// getUserMedia failure -> a message the user can actually act on. Without
// this, any failure that isn't the media-busy case (most commonly denied
// mic/camera permission on a fresh install) unwound silently: the call
// screen appeared and vanished with no explanation, and — since the failure
// happens before the call:invite socket emit — the other party never got so
// much as a ring, with nothing in the logs to say why.
function getUserMediaErrorMessage(err: unknown): string {
  if (isMediaBusyError(err)) return MEDIA_BUSY_MESSAGE;
  const name = (err as { name?: string } | null | undefined)?.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Beacon needs camera and microphone access to make calls. Enable it in Settings and try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No camera or microphone was found on this device.";
  }
  return "Couldn't start the call. Please try again.";
}

function safeCallKeep(action: () => void) {
  try {
    action();
  } catch (err) {
    console.warn("[call] CallKeep action failed", err);
  }
}

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
  // True while the OS has taken the audio session away from this call for
  // another one (e.g. a cellular call rang mid-call) — the local mic/camera
  // are paused for the duration, see the didDeactivateAudioSession listener.
  isSystemInterrupted: boolean;
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
  const [isSystemInterrupted, setIsSystemInterrupted] = useState(false);

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
  // Whether CallKit (iOS) / self-managed ConnectionService (Android) is up.
  // Setup fails on simulators, Expo Go, and some older Android builds — every
  // CallKeep call site is gated on this so those environments fall back to
  // the pre-CallKeep behavior instead of throwing.
  const callKeepReadyRef = useRef(false);
  const isSystemInterruptedRef = useRef(false);
  const wasMutedBeforeInterruptionRef = useRef(false);
  const wasCameraOffBeforeInterruptionRef = useRef(false);
  // Set right before RNCallKeep.startCall() for an outgoing call; the actual
  // getUserMedia/offer/signaling work is deferred into the
  // didReceiveStartCallAction listener, which is when CallKit/ConnectionService
  // has actually accepted the call attempt (see performOutgoingCallSetup).
  const pendingOutgoingRef = useRef<{ callId: string; conversationId: string; kind: CallKind } | null>(null);

  useEffect(() => {
    callRef.current = call;
  }, [call]);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    isSystemInterruptedRef.current = isSystemInterrupted;
  }, [isSystemInterrupted]);

  // One-time setup so every subsequent call is registered with CallKit
  // (iOS) / Telecom's self-managed ConnectionService (Android) — this is
  // what lets the OS arbitrate against a simultaneous cellular call or
  // another CallKit-integrated VoIP app instead of both apps fighting over
  // the mic/audio route. Deliberately not gated on `token`: registering the
  // phone account shouldn't depend on being signed in, and must happen
  // before any call (including one arriving right after sign-in) can use it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await RNCallKeep.setup({
          ios: {
            appName: "Beacon",
            supportsVideo: true,
            includesCallsInRecents: false,
          },
          android: {
            alertTitle: "Phone account required",
            alertDescription: "Beacon needs access to your phone accounts to manage calls and avoid conflicts with other calls.",
            cancelButton: "Cancel",
            okButton: "OK",
            selfManaged: true,
            additionalPermissions: [],
            foregroundService: {
              channelId: "com.beaconchat.app.calls",
              channelName: "Beacon calls",
              notificationTitle: "Beacon call in progress",
            },
          },
        });
        if (cancelled) return;
        if (Platform.OS === "android") RNCallKeep.setAvailable(true);
        callKeepReadyRef.current = true;
      } catch (err) {
        // Expected on simulators/Expo Go and devices without a Telecom
        // stack that supports self-managed connections — calls still work
        // via the app's own UI, just without OS-level call-waiting
        // arbitration against other apps.
        console.warn("[call] CallKeep unavailable, falling back to app-only call handling", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
            const endedCallId = callRef.current?.callId;
            logCallOutcome(phaseRef.current === "connected" ? "completed" : "failed");
            if (callKeepReadyRef.current && endedCallId) {
              safeCallKeep(() => RNCallKeep.reportEndCallWithUUID(endedCallId, CK_CONSTANTS.END_CALL_REASONS.FAILED));
            }
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

  // The actual media acquisition + signaling for an outgoing call — split
  // out of startCall() so it can run either immediately (CallKeep
  // unavailable) or deferred until didReceiveStartCallAction fires (CallKeep
  // available), which is the point CallKit/ConnectionService has accepted
  // the call attempt rather than rejecting it for an OS-level reason.
  const performOutgoingCallSetup = useCallback(
    async (callId: string, conversationId: string, kind: CallKind) => {
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
                const reason = err ? "no response from the server" : ack && !ack.ok ? ack.error : "unknown error";
                console.warn("[call] call:invite rejected", reason);
                Alert.alert("Call failed", reason === "busy" ? "That person is on another call." : "Couldn't reach the other person. Please try again.");
                logCallOutcome("failed");
                if (callKeepReadyRef.current) {
                  safeCallKeep(() => RNCallKeep.reportEndCallWithUUID(callId, CK_CONSTANTS.END_CALL_REASONS.FAILED));
                }
                dismissCallScreen();
                cleanup();
              }
            }
          );

        ringTimeoutRef.current = setTimeout(() => {
          if (phaseRef.current === "outgoing-ringing") {
            getSocket().emit("call:end", { callId });
            if (callKeepReadyRef.current) safeCallKeep(() => RNCallKeep.endCall(callId));
            logCallOutcome("missed");
            dismissCallScreen();
            cleanup();
          }
        }, RING_TIMEOUT_MS);
      } catch (err) {
        console.warn("[call] failed to start call", err);
        Alert.alert("Can't start call", getUserMediaErrorMessage(err));
        logCallOutcome("failed");
        if (callKeepReadyRef.current) {
          safeCallKeep(() => RNCallKeep.reportEndCallWithUUID(callId, CK_CONSTANTS.END_CALL_REASONS.FAILED));
        }
        dismissCallScreen();
        cleanup();
      }
    },
    [cleanup, createPeerConnection, logCallOutcome]
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

      if (!callKeepReadyRef.current) {
        void performOutgoingCallSetup(callId, conversationId, kind);
        return;
      }

      pendingOutgoingRef.current = { callId, conversationId, kind };
      try {
        RNCallKeep.startCall(callId, conversationId, info.peerName, "generic", kind === "video");
      } catch (err) {
        console.warn("[call] RNCallKeep.startCall failed, proceeding without it", err);
        pendingOutgoingRef.current = null;
        void performOutgoingCallSetup(callId, conversationId, kind);
        return;
      }
      setTimeout(() => {
        if (pendingOutgoingRef.current?.callId !== callId) return;
        console.warn("[call] didReceiveStartCallAction never fired, proceeding without CallKeep");
        pendingOutgoingRef.current = null;
        void performOutgoingCallSetup(callId, conversationId, kind);
      }, CALLKEEP_START_TIMEOUT_MS);
    },
    [performOutgoingCallSetup]
  );

  // CallKit/ConnectionService's contract: the actual call setup work has to
  // happen from within this handler, once the OS has accepted the call
  // attempt (rather than immediately after requesting it).
  useEffect(() => {
    const listener = RNCallKeep.addEventListener("didReceiveStartCallAction", ({ callUUID }) => {
      const pending = pendingOutgoingRef.current;
      if (!pending || !callUUID || pending.callId !== callUUID) return;
      pendingOutgoingRef.current = null;
      void performOutgoingCallSetup(pending.callId, pending.conversationId, pending.kind);
    });
    return () => listener.remove();
  }, [performOutgoingCallSetup]);

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

    // Registers the call with CallKit/ConnectionService so the OS is aware
    // of it — this is what makes a simultaneous cellular call (or another
    // CallKit-integrated VoIP app) show proper call-waiting behavior instead
    // of both apps silently fighting over the mic. The app's own
    // IncomingCallScreen (navigated to above) stays the primary accept/
    // decline surface.
    if (callKeepReadyRef.current) {
      safeCallKeep(() =>
        RNCallKeep.displayIncomingCall(payload.callId, payload.callerId, info.peerName, "generic", payload.kind === "video")
      );
    }

    ringTimeoutRef.current = setTimeout(() => {
      if (phaseRef.current === "incoming-ringing") {
        getSocket().emit("call:reject", { callId: payload.callId });
        if (callKeepReadyRef.current) safeCallKeep(() => RNCallKeep.rejectCall(payload.callId));
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

    if (callKeepReadyRef.current) safeCallKeep(() => RNCallKeep.answerIncomingCall(invite.callId));

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
      Alert.alert("Can't answer call", getUserMediaErrorMessage(err));
      getSocket().emit("call:end", { callId: invite.callId });
      if (callKeepReadyRef.current) {
        safeCallKeep(() => RNCallKeep.reportEndCallWithUUID(invite.callId, CK_CONSTANTS.END_CALL_REASONS.FAILED));
      }
      logCallOutcome("failed");
      dismissCallScreen();
      cleanup();
    }
  }, [cleanup, clearRingTimeout, createPeerConnection, flushPendingCandidates, logCallOutcome]);

  const rejectIncomingCall = useCallback(() => {
    const invite = incomingInviteRef.current;
    if (!invite) return;
    getSocket().emit("call:reject", { callId: invite.callId });
    if (callKeepReadyRef.current) safeCallKeep(() => RNCallKeep.rejectCall(invite.callId));
    logCallOutcome("declined");
    dismissCallScreen();
    cleanup();
  }, [cleanup, logCallOutcome]);

  const endCall = useCallback(() => {
    const info = callRef.current;
    if (!info) return;
    getSocket().emit("call:end", { callId: info.callId });
    if (callKeepReadyRef.current) safeCallKeep(() => RNCallKeep.endCall(info.callId));
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
      if (callKeepReadyRef.current) {
        safeCallKeep(() =>
          RNCallKeep.reportEndCallWithUUID(
            payload.callId,
            payload.reason === "rejected"
              ? CK_CONSTANTS.END_CALL_REASONS.DECLINED_ELSEWHERE
              : CK_CONSTANTS.END_CALL_REASONS.REMOTE_ENDED
          )
        );
      }
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

  // Mirrors the system's own mute button (car Bluetooth, CallKit's lock
  // screen card) back into our WebRTC track/UI state.
  useEffect(() => {
    const listener = RNCallKeep.addEventListener("didPerformSetMutedCallAction", ({ muted, callUUID }) => {
      if (callRef.current?.callId !== callUUID) return;
      const track = localStreamRef.current?.getAudioTracks()[0];
      if (track) track.enabled = !muted;
      setIsMuted(muted);
    });
    return () => listener.remove();
  }, []);

  // The app's own IncomingCallScreen is the primary answer surface, but on a
  // locked or backgrounded device the OS's native CallKit/ConnectionService
  // UI is what's actually on screen — tapping Accept there fires this event
  // instead of going through our button, so it has to trigger the same flow.
  useEffect(() => {
    const listener = RNCallKeep.addEventListener("answerCall", ({ callUUID }) => {
      if (incomingInviteRef.current?.callId !== callUUID) return;
      void acceptIncomingCall();
    });
    return () => listener.remove();
  }, [acceptIncomingCall]);

  // Same deal for hanging up/declining from the native UI (lock screen,
  // system call banner) rather than our own end/decline buttons.
  useEffect(() => {
    const listener = RNCallKeep.addEventListener("endCall", ({ callUUID }) => {
      if (callRef.current?.callId !== callUUID) return;
      if (phaseRef.current === "incoming-ringing") {
        rejectIncomingCall();
      } else if (phaseRef.current !== "idle") {
        endCall();
      }
    });
    return () => listener.remove();
  }, [rejectIncomingCall, endCall]);

  // The core "gracefully manage camera/mic as system resources become
  // available" behavior: when the OS hands our audio session to another
  // call (e.g. a cellular call rings mid-Beacon-call), pause our local
  // tracks rather than let them silently lose the hardware; resume them
  // (respecting whatever the user had manually muted/camera-off'd going in)
  // once the OS hands the session back.
  useEffect(() => {
    const onDeactivated = () => {
      if (phaseRef.current !== "connected") return;
      const audioTrack = localStreamRef.current?.getAudioTracks()[0];
      const videoTrack = localStreamRef.current?.getVideoTracks()[0];
      wasMutedBeforeInterruptionRef.current = audioTrack ? !audioTrack.enabled : false;
      wasCameraOffBeforeInterruptionRef.current = videoTrack ? !videoTrack.enabled : false;
      if (audioTrack) audioTrack.enabled = false;
      if (videoTrack) videoTrack.enabled = false;
      setIsSystemInterrupted(true);
    };

    const onActivated = () => {
      // Also fires on the initial activation for a normal call (outgoing
      // once CallKit connects it, incoming once answered) — only meaningful
      // here as a *resume* signal, so ignore it unless we were actually
      // mid-interruption.
      if (!isSystemInterruptedRef.current) return;
      const audioTrack = localStreamRef.current?.getAudioTracks()[0];
      const videoTrack = localStreamRef.current?.getVideoTracks()[0];
      if (audioTrack && !wasMutedBeforeInterruptionRef.current) audioTrack.enabled = true;
      if (videoTrack && !wasCameraOffBeforeInterruptionRef.current) videoTrack.enabled = true;
      setIsSystemInterrupted(false);
    };

    const deactivatedListener = RNCallKeep.addEventListener("didDeactivateAudioSession", onDeactivated);
    const activatedListener = RNCallKeep.addEventListener("didActivateAudioSession", onActivated);
    return () => {
      deactivatedListener.remove();
      activatedListener.remove();
    };
  }, []);

  const toggleMute = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const nowMuted = !track.enabled;
    setIsMuted(nowMuted);
    // Android's self-managed ConnectionService has no equivalent JS setter
    // for this (see index.d.ts) — the local track flip above is all that
    // platform needs. iOS's CallKit UI/hardware buttons (car Bluetooth, the
    // lock-screen call card) need to be told explicitly or they'll disagree
    // with our in-app mute button.
    if (callKeepReadyRef.current && Platform.OS === "ios" && callRef.current) {
      safeCallKeep(() => RNCallKeep.setMutedCall(callRef.current!.callId, nowMuted));
    }
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
      isSystemInterrupted,
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
      isSystemInterrupted,
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
