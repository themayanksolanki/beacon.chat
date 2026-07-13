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
import { Alert, PermissionsAndroid, Platform, Vibration, type Permission } from "react-native";
import { StackActions } from "@react-navigation/native";
import * as Crypto from "expo-crypto";
import InCallManager from "react-native-incall-manager";
import RNCallKeep, { CONSTANTS as CK_CONSTANTS } from "react-native-callkeep";
import {
  mediaDevices,
  MediaStream,
  MediaStreamTrack,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCRtpSender,
  RTCSessionDescription,
} from "react-native-webrtc";

import {
  getConversationById,
  insertCall,
  insertCallIfAbsent,
  isUserBlocked,
  updateCallOutcome,
  type CallKind,
  type CallStatus,
} from "../db/database";
import { notifyConversationActivity } from "../chat/conversationActivity";
import { getSocket } from "../network/socket";
import { useAuth } from "../auth/AuthContext";
import { dismissCallScreen, navigationRef } from "../navigation/navigationRef";
import { getTurnCredentials, type IceServerConfig } from "../api/client";

// STUN alone only gets two peers connected directly when at least one side's
// NAT allows it — very common failure mode on Android is a carrier's
// cellular network doing symmetric/CGNAT-style NAT, where STUN can't
// discover a usable public mapping at all and ICE gathering just comes up
// empty (the call then times out or connects one-way). A TURN server relays
// media through itself as a fallback for exactly that case.
const STUN_SERVERS: IceServerConfig[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// Fetched fresh per call rather than read from a static bundled value (see
// api/client.ts's getTurnCredentials) — Twilio mints a short-lived
// username/password per request, so nothing long-lived ever ships in the
// app. Falls back to STUN-only (unchanged prior behavior) if the server
// hasn't got Twilio configured, or the request fails for any reason — a
// missing/broken TURN fetch should degrade the call's NAT-traversal odds,
// never block placing or answering one.
async function buildIceServers(token: string | null): Promise<IceServerConfig[]> {
  if (!token) return STUN_SERVERS;
  try {
    const { iceServers } = await getTurnCredentials(token);
    return [...STUN_SERVERS, ...iceServers];
  } catch (err) {
    console.warn("[call] failed to fetch TURN credentials, falling back to STUN-only", err);
    return STUN_SERVERS;
  }
}
const RING_TIMEOUT_MS = 45000;
// Some environments (e.g. Android with a self-managed phone account the user
// hasn't authorized yet) accept RNCallKeep.startCall() without ever firing
// didReceiveStartCallAction — this bounds how long we wait for it before
// falling back to placing the call directly, same as the try/catch below.
const CALLKEEP_START_TIMEOUT_MS = 4000;
// How long to wait, once the peer connection goes "disconnected"/"failed",
// for an ICE restart to bring it back before treating the call as truly
// over — long enough to cover a real reconnection round-trip (restartIce ->
// negotiationneeded -> offer/answer over the signaling socket -> new ICE
// checks), short enough not to leave the UI looking "connected" over dead
// air for too long.
const ICE_RECOVERY_GRACE_MS = 10000;

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

// react-native-webrtc's own getUserMedia only rejects when *both* audio and
// video permissions are denied (see its getUserMedia.ts) — for a video call
// where the camera permission is already granted from an earlier call, a
// denied RECORD_AUDIO silently gets dropped from the constraints instead,
// resolving with a video-only stream. The call then proceeds to "connected"
// with no audio track ever added to the peer connection and no error
// anywhere — the other party just never hears the Android caller. Request
// (and gate on) the exact permissions needed ourselves first, throwing the
// same NotAllowedError shape getUserMediaErrorMessage already handles so
// this reuses the existing catch/Alert wiring at each call site below.
async function ensureAndroidCallPermissions(needsAudio: boolean, needsVideo: boolean): Promise<void> {
  if (Platform.OS !== "android") return;
  const permissions: Permission[] = [];
  if (needsAudio) permissions.push(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  if (needsVideo) permissions.push(PermissionsAndroid.PERMISSIONS.CAMERA);
  if (permissions.length === 0) return;
  const results = await PermissionsAndroid.requestMultiple(permissions);
  const denied = permissions.some((p) => results[p] !== PermissionsAndroid.RESULTS.GRANTED);
  if (denied) throw { name: "NotAllowedError", message: "camera/microphone permission denied" };
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
  peerAvatarUrl: string | null;
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
  isRemoteMuted: boolean;
  isSpeakerOn: boolean;
  isCameraOff: boolean;
  isRemoteCameraOff: boolean;
  // True while our outgoing video is a screen capture rather than the
  // camera — same underlying video sender/m-line, just a different source
  // track (see toggleScreenShare), so this is tracked independently of
  // isCameraOff rather than as a kind of camera state.
  isScreenSharing: boolean;
  isRemoteScreenSharing: boolean;
  // True while the front camera is active — used to mirror the local
  // preview (feels like a real mirror) without mirroring the back camera
  // (which should show the true, unflipped scene, same as what the peer
  // sees — mirroring is a purely local rendering choice, never part of the
  // transmitted video).
  isFrontCamera: boolean;
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
  toggleScreenShare: () => Promise<void>;
}

const CallContext = createContext<CallContextValue | null>(null);

export function CallProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();

  const [phase, setPhase] = useState<CallPhase>("idle");
  const [call, setCall] = useState<CallInfo | null>(null);
  const [localStreamURL, setLocalStreamURL] = useState<string | null>(null);
  const [remoteStreamURL, setRemoteStreamURL] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isRemoteMuted, setIsRemoteMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [isRemoteCameraOff, setIsRemoteCameraOff] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isRemoteScreenSharing, setIsRemoteScreenSharing] = useState(false);
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [callDurationSec, setCallDurationSec] = useState(0);
  const [isSystemInterrupted, setIsSystemInterrupted] = useState(false);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  // The RTCRtpSender carrying our outgoing video, captured whenever a video
  // track is first added (initial call setup or toggleCamera's addTrack
  // branch) — screen sharing swaps its track via replaceTrack rather than
  // hunting for "the video sender" by track identity each time, since a
  // sender's .track goes null/changes exactly when this is used.
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  // Holds the getDisplayMedia() stream while screen sharing is active, so
  // its track(s) can be stopped when sharing ends (replaceTrack alone
  // doesn't release the underlying capturer).
  const screenStreamRef = useRef<MediaStream | null>(null);
  // Guards toggleScreenShare against a second tap landing while the first
  // getDisplayMedia()/replaceTrack call is still in flight.
  const screenShareTogglingRef = useRef(false);
  // Fallback accumulator for the remote track handler below — only used
  // when a "track" event arrives with an empty event.streams (a known
  // react-native-webrtc Android gap). Tracks every remote track seen so far;
  // each new one triggers building a brand-new MediaStream (see the track
  // handler for why it can't just be added to a single persistent stream).
  const remoteTracksRef = useRef<MediaStreamTrack[]>([]);
  // The MediaStream currently backing remoteStreamURL when using the
  // fallback above — kept only so it can be released (without touching the
  // still-in-use tracks) once superseded by a newer one.
  const remoteStreamAccumulatorRef = useRef<MediaStream | null>(null);
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
  // Guards against two concurrent renegotiations (e.g. both sides tapping
  // the camera button at once) — this app has no perfect-negotiation/glare
  // handling, so a simple "skip if one is already in flight" is the extent
  // of the protection rather than queueing/rollback.
  const renegotiatingRef = useRef(false);
  // A second incoming renegotiate-offer can arrive while the first is still
  // being processed (e.g. the peer's own connectionstatechange flapping
  // disconnected/failed more than once for the same blip, each independently
  // calling restartIce()) — processing two concurrently on this side alone
  // reproduces the exact "Called in wrong state: stable" crash the
  // politeness check below handles for the offer-vs-offer case, just
  // without a peer-side offer in flight to make it a "collision" by that
  // check's definition. This is a plain reentrancy guard, unconditional on
  // politeness: a second offer arriving mid-processing is simply dropped.
  const applyingRenegotiateOfferRef = useRef(false);
  // Grace-period timer between the peer connection going "disconnected"/
  // "failed" and actually ending the call (see connectionstatechange below)
  // — gives a same-network blip (Wi-Fi<->cellular handoff, a brief signal
  // drop) a chance to recover via ICE restart instead of hanging up on the
  // first hiccup, the way a plain STUN-only connection otherwise would.
  const iceRecoveryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only attempt one restartIce() per disconnection episode — cleared once
  // the connection actually recovers (back to connected/completed).
  const iceRestartAttemptedRef = useRef(false);

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
        // Self-managed ConnectionService.createConnection() calls
        // TelecomManager.getPhoneAccount() internally, which throws an
        // uncaught SecurityException (crashing the whole app, not just the
        // call) without READ_PHONE_NUMBERS actually *granted* — declaring it
        // in the manifest (app.json's android.permissions) is necessary but
        // not sufficient, and CallKeep's own `additionalPermissions` option
        // does not reliably surface the runtime prompt in this dev-client/
        // Bridgeless setup (verified: permission stayed ungranted with only
        // that option set). Request explicitly and await the result so
        // setup() never runs — and no call can be placed — with the
        // permission still missing.
        if (Platform.OS === "android") {
          const results = await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
            PermissionsAndroid.PERMISSIONS.READ_PHONE_NUMBERS,
          ]);
          const granted = Object.values(results).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
          if (!granted) {
            // Denied: leave callKeepReadyRef false so startCall/handleInvite fall
            // back to the app-only call path (see performOutgoingCallSetup) rather
            // than reaching RNCallKeep.startCall(), which is what triggers the
            // native createConnection() crash without this permission.
            console.warn("[call] phone permissions denied, falling back to app-only call handling");
            return;
          }
        }
        if (cancelled) return;
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
            // Permission is requested explicitly above — CallKeep's own
            // handling of this option isn't reliable here (see above), but
            // the type still requires the field.
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
    // The finalized outcome/duration can change what the conversation list
    // shows as this conversation's last activity — see conversationActivity.ts.
    notifyConversationActivity();
  }, []);

  const cleanup = useCallback(() => {
    clearRingTimeout();
    if (iceRecoveryTimeoutRef.current) {
      clearTimeout(iceRecoveryTimeoutRef.current);
      iceRecoveryTimeoutRef.current = null;
    }
    iceRestartAttemptedRef.current = false;
    Vibration.cancel();
    InCallManager.stopRingtone();
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    videoSenderRef.current = null;
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    screenShareTogglingRef.current = false;
    remoteStreamAccumulatorRef.current?.release(false);
    remoteStreamAccumulatorRef.current = null;
    remoteTracksRef.current = [];
    pendingCandidatesRef.current = [];
    remoteDescriptionSetRef.current = false;
    incomingInviteRef.current = null;
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
    connectedAtRef.current = null;
    renegotiatingRef.current = false;
    InCallManager.stop();
    setLocalStreamURL(null);
    setRemoteStreamURL(null);
    setIsMuted(false);
    setIsRemoteMuted(false);
    setIsSpeakerOn(false);
    setIsCameraOff(true);
    setIsRemoteCameraOff(true);
    setIsScreenSharing(false);
    setIsRemoteScreenSharing(false);
    setIsFrontCamera(true);
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
    async (callId: string) => {
      const iceServers = await buildIceServers(token);
      const pc = new RTCPeerConnection({
        iceServers,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
        iceCandidatePoolSize: 10,
      });
      // react-native-webrtc's RTCPeerConnection typings don't resolve cleanly
      // through Expo's "bundler" moduleResolution (event-target-shim's
      // package.json doesn't export the "/index" subpath its own .d.ts
      // imports) — addEventListener works fine at runtime, so cast around it.
      const events = pc as unknown as {
        addEventListener(type: "icecandidate", listener: (event: { candidate: RTCIceCandidate | null }) => void): void;
        addEventListener(
          type: "track",
          listener: (event: { streams: MediaStream[]; track: MediaStreamTrack }) => void
        ): void;
        addEventListener(type: "connectionstatechange", listener: () => void): void;
        addEventListener(type: "iceconnectionstatechange", listener: () => void): void;
        
        addEventListener(type: "negotiationneeded", listener: () => void): void;
      };

      events.addEventListener("icecandidate", (event) => {
        if (event.candidate) {
          getSocket().emit("call:ice-candidate", { callId, candidate: event.candidate.toJSON() });
        }
      });

      events.addEventListener("track", (event) => {
        // Audio and video normally arrive as two separate track events —
        // this has to accumulate, but NOT by reusing one persistent
        // MediaStream and re-emitting the same stream.toURL() each time.
        // Android's native RTCView (WebRTCView.java's setStreamURL) only
        // re-resolves which VideoTrack to render when the streamURL PROP
        // STRING actually changes, and toURL() returns a stream's id, which
        // is stable for the life of that MediaStream object. That holds
        // whether or not event.streams itself came back empty (a
        // long-standing react-native-webrtc Android gap): even when
        // event.streams[0] IS populated, react-native-webrtc's own
        // RTCPeerConnection reuses the SAME MediaStream instance (keyed by
        // streamId) for every track event sharing one msid — the ordinary
        // case for a bundled audio+video SDP — so if audio arrives first
        // (binding to that stream, no video yet) and video arrives later
        // added to that *same* instance, the prop never changes and the
        // native view never re-binds to the now-available video track:
        // black video, forever, on Android specifically (reproduced and
        // confirmed against both the WebRTCView.java and
        // RTCPeerConnection.ts source — restarting the app only "fixes" it
        // by getting lucky on event-ordering, not by fixing the cause).
        // Building a brand-new MediaStream (fresh id) with everything
        // accumulated so far, every time a new track shows up, guarantees
        // the prop changes and Android re-resolves the video track — this
        // is done unconditionally, ignoring event.streams entirely, rather
        // than only as a fallback for the empty case. The old wrapper is
        // released (not its tracks, which are still owned by the peer
        // connection) once superseded.
        if (!remoteTracksRef.current.includes(event.track)) {
          remoteTracksRef.current = [...remoteTracksRef.current, event.track];
        }
        const previous = remoteStreamAccumulatorRef.current;
        const stream = new MediaStream(remoteTracksRef.current);
        remoteStreamAccumulatorRef.current = stream;
        previous?.release(false);
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

      // The actual end-the-call side effects, factored out so both the
      // immediate "closed" path and the ICE-recovery grace-period timeout
      // below (connectionstatechange) can share it.
      const endCallForConnectionFailure = () => {
        if (phaseRef.current === "idle") return;
        // Every other self-initiated way a call ends (endCall,
        // rejectIncomingCall, both ring-timeouts, the acceptIncomingCall/
        // performOutgoingCallSetup catch blocks) tells the server via
        // call:end so it clears activeCalls/userActiveCall — this path
        // was the one exception, silently cleaning up only the local
        // React state. The server's bookkeeping was left stuck "in a
        // call" indefinitely (nothing else was ever going to clear it —
        // the peer's socket is still perfectly connected), so the very
        // next call attempt to or from either party got hard-rejected
        // as "busy"/"That person is on another call" even though the
        // call had genuinely ended on this device.
        getSocket().emit("call:end", { callId });
        logCallOutcome(phaseRef.current === "connected" ? "completed" : "failed");
        if (callKeepReadyRef.current) {
          safeCallKeep(() => RNCallKeep.reportEndCallWithUUID(callId, CK_CONSTANTS.END_CALL_REASONS.FAILED));
        }
        dismissCallScreen();
        cleanup();
      };

      events.addEventListener("iceconnectionstatechange", () => {
        console.log("ICE:", pc.iceConnectionState);

        switch (pc.iceConnectionState) {
          case "failed":
            console.log("ICE failed");
            break;

          case "disconnected":
            console.log("ICE disconnected");
            break;

          case "connected":
          case "completed":
            console.log("ICE connected");
            break;
        }
      });

      events.addEventListener("connectionstatechange", async () => {
        const state = pc.connectionState;

        if (state === "connected") {
          // Recovered from a "disconnected"/"failed" blip (or this is the
          // first time connecting) — cancel any pending grace-period
          // teardown and allow a future disconnection to try its own
          // restart again.
          if (iceRecoveryTimeoutRef.current) {
            clearTimeout(iceRecoveryTimeoutRef.current);
            iceRecoveryTimeoutRef.current = null;
          }
          iceRestartAttemptedRef.current = false;
          return;
        }

        if (state === "disconnected" || state === "failed") {
          if (phaseRef.current === "idle") return;
          // A recovery window is already running for this episode.
          if (iceRecoveryTimeoutRef.current) return;

          if (!iceRestartAttemptedRef.current) {
            // With STUN-only ICE (no TURN configured — see ICE_SERVERS
            // above), a same-network blip (Wi-Fi<->cellular handoff, a
            // brief signal drop, especially common on Android mobile data)
            // used to end the call immediately on the very first "failed"
            // state instead of trying to recover, the way a real calling
            // app (WhatsApp/Signal) would. restartIce() triggers a
            // "negotiationneeded" event (handled below), which redoes the
            // offer/answer exchange over the existing signaling socket —
            // this can only recover a transient blip, not a genuinely
            // unreachable network path (that still needs a TURN relay).
            iceRestartAttemptedRef.current = true;
            console.warn(`[call] connection ${state}, attempting ICE restart`);
            try {
                pc.restartIce();

                const offer = await pc.createOffer({
                    iceRestart: true,
                });

                await pc.setLocalDescription(offer);
                const info = callRef.current;
                getSocket().emit("call:renegotiate-offer", {
                    callId,
                    sdp: pc.localDescription!.toJSON(),
                    kind: info?.kind,
                });

            } catch (err) {
                console.warn(err);
            }
          }

          iceRecoveryTimeoutRef.current = setTimeout(() => {
            iceRecoveryTimeoutRef.current = null;
            const finalState = pc.connectionState;
            if (finalState !== "connected") {
              endCallForConnectionFailure();
            }
          }, ICE_RECOVERY_GRACE_MS);
          return;
        }

        if (state === "closed") {
          // The connection was explicitly torn down (by either side) —
          // nothing left to restart, so no grace period, unlike above.
          if (iceRecoveryTimeoutRef.current) {
            clearTimeout(iceRecoveryTimeoutRef.current);
            iceRecoveryTimeoutRef.current = null;
          }
          endCallForConnectionFailure();
        }
      });

      // Fires after restartIce() (recovering from a disconnected/failed
      // state above), and also after toggleCamera's addTrack — guarded by
      // the same renegotiatingRef that flow already sets before this could
      // fire, so it won't double-send an offer for that case. Ignored
      // before the call has actually connected once: the initial
      // offer/answer is created explicitly by performOutgoingCallSetup/
      // acceptIncomingCall, not through this generic path.
      events.addEventListener("negotiationneeded", () => {
        if (phaseRef.current !== "connected" || renegotiatingRef.current) return;
        const info = callRef.current;
        if (!info || info.callId !== callId) return;
        renegotiatingRef.current = true;
        (async () => {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            getSocket().emit("call:renegotiate-offer", {
              callId,
              sdp: pc.localDescription!.toJSON(),
              kind: info.kind,
            });
            // renegotiatingRef is cleared once the peer's answer arrives —
            // see handleRenegotiateAnswer — not here, same as toggleCamera.
          } catch (err) {
            console.warn("[call] ICE-restart renegotiation failed", err);
            renegotiatingRef.current = false;
          }
        })();
      });

      peerConnectionRef.current = pc;
      return pc;
    },
    [cleanup, logCallOutcome, token]
  );

  // The actual media acquisition + signaling for an outgoing call — split
  // out of startCall() so it can run either immediately (CallKeep
  // unavailable) or deferred until didReceiveStartCallAction fires (CallKeep
  // available), which is the point CallKit/ConnectionService has accepted
  // the call attempt rather than rejecting it for an OS-level reason.
  const performOutgoingCallSetup = useCallback(
    async (callId: string, conversationId: string, kind: CallKind) => {
      // This can run after a delay (waiting on CallKeep's
      // didReceiveStartCallAction, or its own fallback timeout) — if the
      // user already cancelled during that wait, skip the camera/mic prompt
      // entirely rather than acquiring it just to release it once the
      // checks further down catch the same mismatch.
      if (callRef.current?.callId !== callId) return;
      try {
        await ensureAndroidCallPermissions(true, kind === "video");
        const localStream = await mediaDevices.getUserMedia({
          audio: true,
          video:
            kind === "video"
              ? {
                  facingMode: "user",
                  width: {
                    ideal: 640,
                  },
                  height: {
                    ideal: 480,
                  },
                  frameRate: {
                    ideal: 24,
                    max: 30,
                  },
                }
              : false,
        });

        // The user can hang up (endCall -> cleanup) while permissions/
        // getUserMedia were still in flight above — cleanup() nulls callRef
        // and resets phase, but it can't reach into THIS async call to stop
        // it mid-flight, so without this check the function just kept going:
        // acquiring the camera, creating an offer, and emitting call:invite
        // for a call the caller's own UI had already torn down. The callee
        // then rang for a call nobody was on, with no cancel ever coming
        // (the caller's client no longer thinks this call exists at all, so
        // there's nothing left to tell the server to relay). Bail out and
        // release whatever this attempt already acquired instead.
        if (callRef.current?.callId !== callId) {
          localStream.getTracks().forEach((track) => track.stop());
          return;
        }

        localStreamRef.current = localStream;
        setLocalStreamURL(localStream.toURL());
        setIsCameraOff(kind !== "video");
        setIsRemoteCameraOff(kind !== "video");
        InCallManager.start({ media: kind === "video" ? "video" : "audio" });

        const pc = await createPeerConnection(callId);

        // The user can hang up while the TURN-credential fetch above was
        // still in flight — same race as the getUserMedia check below, just
        // one step earlier now that peer connection creation is async too.
        if (callRef.current?.callId !== callId) {
          pc.close();
          return;
        }

        localStream.getTracks().forEach((track) => {
          const sender = pc.addTrack(track, localStream);
          if (track.kind === "video") videoSenderRef.current = sender;
        });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Same race, checked again — cancellation could just as easily have
        // landed during createOffer/setLocalDescription instead.
        if (callRef.current?.callId !== callId) {
          pc.close();
          return;
        }

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
      if (isUserBlocked(conversationId)) return;
      const conversation = getConversationById(conversationId);
      if (!conversation) return;

      const callId = Crypto.randomUUID();
      const info: CallInfo = {
        callId,
        conversationId,
        peerName: conversation.display_name ?? "Unknown",
        peerAvatarUrl: conversation.avatar_url,
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
      notifyConversationActivity();

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
    if (isUserBlocked(payload.callerId)) {
      // No server-side concept of blocking (see database.ts) — the caller's
      // client still emits the invite, so silently decline it here rather
      // than ringing/vibrating/showing the incoming-call screen.
      getSocket().emit("call:reject", { callId: payload.callId });
      return;
    }
    const conversation = getConversationById(payload.callerId);
    incomingInviteRef.current = payload;

    const info: CallInfo = {
      callId: payload.callId,
      conversationId: payload.callerId,
      peerName: conversation?.display_name ?? "Unknown",
      peerAvatarUrl: conversation?.avatar_url ?? null,
      kind: payload.kind,
      direction: "incoming",
    };
    setCall(info);
    setPhase("incoming-ringing");
    if (navigationRef.isReady()) navigationRef.navigate("IncomingCall");
    Vibration.vibrate([500, 1000, 500, 1000], true);
    // CallKeep (below) would normally trigger the OS's own ringtone, but it's
    // routinely unavailable (simulators, Expo Go, devices without a Telecom
    // stack supporting self-managed connections — see the CallKeep setup
    // effect) and silently no-ops when it is. Without this, those cases rang
    // with vibration only and no audible sound at all. vibrate_pattern is `0`
    // (not `[]`) since Vibration.vibrate above already covers vibration
    // cross-platform — InCallManager's JS wrapper only checks
    // Array.isArray(vibrate_pattern), so an empty array still triggers its own
    // Vibration.vibrate([], false) call, which is silently harmless on iOS but
    // throws IllegalArgumentException natively on Android (VibrationEffect
    // .createWaveform rejects an empty pattern), killing the whole app.
    InCallManager.startRingtone("_DEFAULT_", 0, "playAndRecord", 30);

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
    notifyConversationActivity();

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
    InCallManager.stopRingtone();
    setPhase("connecting");
    if (navigationRef.isReady()) {
      navigationRef.dispatch(StackActions.replace("ActiveCall"));
    }

    if (callKeepReadyRef.current) safeCallKeep(() => RNCallKeep.answerIncomingCall(invite.callId));

    try {
      await ensureAndroidCallPermissions(true, invite.kind === "video");
      const localStream = await mediaDevices.getUserMedia({
        audio: true,
        video:
          invite.kind === "video"
            ? {
                facingMode: "user",
                width: {
                  ideal: 640,
                },
                height: {
                  ideal: 480,
                },
                frameRate: {
                  ideal: 24,
                  max: 30,
                },
              }
            : false,
      });

      // Same race as performOutgoingCallSetup's callRef check: the caller
      // could have ended the call (handleRemoteCancel/handleRemoteEnd ->
      // cleanup()) while permissions/getUserMedia were still in flight —
      // continuing on would answer a call this device no longer thinks is
      // happening at all.
      if (callRef.current?.callId !== invite.callId) {
        localStream.getTracks().forEach((track) => track.stop());
        return;
      }

      localStreamRef.current = localStream;
      setLocalStreamURL(localStream.toURL());
      setIsCameraOff(invite.kind !== "video");
      setIsRemoteCameraOff(invite.kind !== "video");
      InCallManager.start({ media: invite.kind === "video" ? "video" : "audio" });

      const pc = await createPeerConnection(invite.callId);

      // Same race, one step earlier — the caller could have cancelled while
      // the TURN-credential fetch inside createPeerConnection was in flight.
      if (callRef.current?.callId !== invite.callId) {
        pc.close();
        return;
      }

      localStream.getTracks().forEach((track) => {
        const sender = pc.addTrack(track, localStream);
        if (track.kind === "video") videoSenderRef.current = sender;
      });

      await pc.setRemoteDescription(new RTCSessionDescription(invite.sdp));
      remoteDescriptionSetRef.current = true;
      await flushPendingCandidates(pc);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Checked again — cancellation could just as easily have landed during
      // setRemoteDescription/createAnswer instead.
      if (callRef.current?.callId !== invite.callId) {
        pc.close();
        return;
      }

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

  const handleRemoteCameraState = useCallback((payload: { callId: string; cameraOn: boolean }) => {
    if (callRef.current?.callId !== payload.callId) return;
    setIsRemoteCameraOff(!payload.cameraOn);
  }, []);

  const handleRemoteScreenShareState = useCallback((payload: { callId: string; sharing: boolean }) => {
    if (callRef.current?.callId !== payload.callId) return;
    setIsRemoteScreenSharing(payload.sharing);
  }, []);

  const handleRemoteMuteState = useCallback((payload: { callId: string; muted: boolean }) => {
    if (callRef.current?.callId !== payload.callId) return;
    setIsRemoteMuted(payload.muted);
  }, []);

  // The peer just added a video track to a call that didn't have one from
  // them before (audio-only call, or their first time enabling camera) —
  // apply their offer and answer back, same SDP dance as acceptIncomingCall/
  // handleAnswer but without any of the ringing/phase bookkeeping.
  const handleRenegotiateOffer = useCallback(
    async (payload: { callId: string; sdp: { type: string; sdp: string }; kind: CallKind }) => {
      const pc = peerConnectionRef.current;
      const info = callRef.current;
      if (!pc || info?.callId !== payload.callId) return;
      // Glare: both sides can independently notice the same disconnect and
      // each call restartIce() around the same time (see
      // connectionstatechange's ICE-restart above) — each then has its own
      // offer in flight when the peer's offer arrives here. Naively
      // accepting it on both sides corrupts the exchange (reproduced:
      // "Failed to set local answer sdp: Called in wrong state: stable",
      // because the OTHER side's createAnswer/setLocalDescription already
      // completed and returned signalingState to "stable" by the time this
      // side's own concurrent attempt tried to finish). Resolved the
      // standard WebRTC "perfect negotiation" way: politeness is derived
      // from call direction, which is fixed for a call's whole lifetime and
      // already opposite on the two ends — the original callee is "polite"
      // (accepts the incoming offer, implicitly rolling back its own
      // pending one) and the original caller is "impolite" (ignores an
      // incoming offer while it has one of its own in flight, and waits for
      // its own to be answered instead). Only one side needs the special
      // case for this to resolve correctly.
      // Dropped regardless of politeness: a second incoming offer arriving
      // while the first is still mid-flight (no local offer of ours
      // involved at all — see applyingRenegotiateOfferRef's declaration)
      // hits the same "wrong state: stable" crash once the first finishes.
      if (applyingRenegotiateOfferRef.current) return;
      const isPolite = info.direction === "incoming";
      const collision = renegotiatingRef.current || pc.signalingState !== "stable";
      if (collision && !isPolite) return;
      applyingRenegotiateOfferRef.current = true;
      try {
        setCall((prev) => (prev ? { ...prev, kind: payload.kind } : prev));
        if (payload.kind === "video") setIsRemoteCameraOff(false);
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        remoteDescriptionSetRef.current = true;
        await flushPendingCandidates(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        getSocket().emit("call:renegotiate-answer", { callId: payload.callId, sdp: pc.localDescription!.toJSON() });
        // We just answered — any offer WE had in flight was either already
        // done, or (the collision/polite case) just got implicitly rolled
        // back by the setRemoteDescription above, so it has no answer
        // coming. Either way this side is no longer the offerer.
        renegotiatingRef.current = false;
      } catch (err) {
        console.warn("[call] failed to apply renegotiate offer", err);
      } finally {
        applyingRenegotiateOfferRef.current = false;
      }
    },
    [flushPendingCandidates]
  );

  const handleRenegotiateAnswer = useCallback(async (payload: { callId: string; sdp: { type: string; sdp: string } }) => {
    const pc = peerConnectionRef.current;
    if (!pc || callRef.current?.callId !== payload.callId) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    } catch (err) {
      console.warn("[call] failed to apply renegotiate answer", err);
    } finally {
      renegotiatingRef.current = false;
    }
  }, []);

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

  // Fires on every device EXCEPT the one that answered/declined — call:invite
  // rings all of this account's linked devices at once (see socketServer.ts),
  // so once one of them handles the call, the rest need to be told to stop
  // ringing rather than sitting there forever. There's never a peer
  // connection to tear down here (this device never actually answered), just
  // the ringing UI/vibration/CallKit registration from handleInvite.
  const handleRemoteCancel = useCallback(
    (payload: { callId: string }) => {
      if (callRef.current?.callId !== payload.callId) return;
      clearRingTimeout();
      Vibration.cancel();
      logCallOutcome("missed");
      if (callKeepReadyRef.current) {
        safeCallKeep(() =>
          RNCallKeep.reportEndCallWithUUID(payload.callId, CK_CONSTANTS.END_CALL_REASONS.DECLINED_ELSEWHERE)
        );
      }
      dismissCallScreen();
      cleanup();
    },
    [cleanup, clearRingTimeout, logCallOutcome]
  );

  // A call placed while we had zero connected devices — the caller's
  // call:invite never reached us live (see socketServer.ts's call:invite
  // handler and the Call model comment in schema.prisma), so there's no
  // ringing/CallKit/phase to drive here, just backfilling the log entry we
  // missed. Guarded with insertCallIfAbsent (not insertCall) since the
  // server may legitimately re-deliver this if more than one of our devices
  // reconnects around the same time.
  const handleMissedCall = useCallback(
    (payload: { call_id: string; caller_id: string; kind: CallKind; created_at: number }) => {
      if (isUserBlocked(payload.caller_id)) return;
      insertCallIfAbsent({
        id: payload.call_id,
        conversation_id: payload.caller_id,
        direction: "incoming",
        kind: payload.kind,
        status: "missed",
        started_at: payload.created_at,
        answered_at: null,
        ended_at: payload.created_at,
      });
      notifyConversationActivity();
    },
    []
  );

  useEffect(() => {
    if (!token) return;
    const socket = getSocket();
    socket.on("call:invite", handleInvite);
    socket.on("call:answer", handleAnswer);
    socket.on("call:cancel", handleRemoteCancel);
    socket.on("call:ice-candidate", handleRemoteIceCandidate);
    socket.on("call:end", handleRemoteEnd);
    socket.on("call:camera-state", handleRemoteCameraState);
    socket.on("call:screen-share-state", handleRemoteScreenShareState);
    socket.on("call:mute-state", handleRemoteMuteState);
    socket.on("call:renegotiate-offer", handleRenegotiateOffer);
    socket.on("call:renegotiate-answer", handleRenegotiateAnswer);
    socket.on("call:missed", handleMissedCall);
    return () => {
      socket.off("call:invite", handleInvite);
      socket.off("call:answer", handleAnswer);
      socket.off("call:cancel", handleRemoteCancel);
      socket.off("call:ice-candidate", handleRemoteIceCandidate);
      socket.off("call:end", handleRemoteEnd);
      socket.off("call:camera-state", handleRemoteCameraState);
      socket.off("call:screen-share-state", handleRemoteScreenShareState);
      socket.off("call:mute-state", handleRemoteMuteState);
      socket.off("call:renegotiate-offer", handleRenegotiateOffer);
      socket.off("call:renegotiate-answer", handleRenegotiateAnswer);
      socket.off("call:missed", handleMissedCall);
    };
  }, [
    token,
    handleInvite,
    handleAnswer,
    handleRemoteCancel,
    handleRemoteIceCandidate,
    handleRemoteEnd,
    handleRemoteCameraState,
    handleRemoteScreenShareState,
    handleRemoteMuteState,
    handleRenegotiateOffer,
    handleRenegotiateAnswer,
    handleMissedCall,
  ]);

  // Tells the peer our mic just muted/unmuted — shared by the in-app mute
  // button and the system mute listener below, so a "muted" indicator on
  // their end stays accurate regardless of which control was actually used.
  const emitMuteState = useCallback((muted: boolean) => {
    const callId = callRef.current?.callId;
    if (!callId) return;
    getSocket().emit("call:mute-state", { callId, muted });
  }, []);

  // Mirrors the system's own mute button (car Bluetooth, CallKit's lock
  // screen card) back into our WebRTC track/UI state.
  useEffect(() => {
    const listener = RNCallKeep.addEventListener("didPerformSetMutedCallAction", ({ muted, callUUID }) => {
      if (callRef.current?.callId !== callUUID) return;
      const track = localStreamRef.current?.getAudioTracks()[0];
      if (track) track.enabled = !muted;
      setIsMuted(muted);
      emitMuteState(muted);
    });
    return () => listener.remove();
  }, [emitMuteState]);

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

  // Tells the peer our outgoing video just turned on/off so they can swap
  // between our live video and our avatar — shared by the manual camera
  // toggle and the system-interruption pause/resume below, since both flip
  // the same track.enabled flag.
  const emitCameraState = useCallback((cameraOn: boolean) => {
    const callId = callRef.current?.callId;
    if (!callId) return;
    getSocket().emit("call:camera-state", { callId, cameraOn });
  }, []);

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
      if (videoTrack && videoTrack.enabled) {
        videoTrack.enabled = false;
        setIsCameraOff(true);
        emitCameraState(false);
      }
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
      if (videoTrack && !wasCameraOffBeforeInterruptionRef.current) {
        videoTrack.enabled = true;
        setIsCameraOff(false);
        emitCameraState(true);
      }
      setIsSystemInterrupted(false);
    };

    const deactivatedListener = RNCallKeep.addEventListener("didDeactivateAudioSession", onDeactivated);
    const activatedListener = RNCallKeep.addEventListener("didActivateAudioSession", onActivated);
    return () => {
      deactivatedListener.remove();
      activatedListener.remove();
    };
  }, [emitCameraState]);

  const toggleMute = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const nowMuted = !track.enabled;
    setIsMuted(nowMuted);
    emitMuteState(nowMuted);
    // Android's self-managed ConnectionService has no equivalent JS setter
    // for this (see index.d.ts) — the local track flip above is all that
    // platform needs. iOS's CallKit UI/hardware buttons (car Bluetooth, the
    // lock-screen call card) need to be told explicitly or they'll disagree
    // with our in-app mute button.
    if (callKeepReadyRef.current && Platform.OS === "ios" && callRef.current) {
      safeCallKeep(() => RNCallKeep.setMutedCall(callRef.current!.callId, nowMuted));
    }
  }, [emitMuteState]);

  const toggleSpeaker = useCallback(() => {
    setIsSpeakerOn((prev) => {
      const next = !prev;
      InCallManager.setForceSpeakerphoneOn(next);
      return next;
    });
  }, []);

  // Two cases: a video call's camera already has a track — just flip
  // enabled (fast path, unchanged from before). Or this call started
  // audio-only and has no outgoing video track yet — acquire the camera and
  // renegotiate to add it, which is also how an audio call becomes a video
  // call (either side can do this independently).
  const toggleCamera = useCallback(async () => {
    const existingTrack = localStreamRef.current?.getVideoTracks()[0];
    if (existingTrack) {
      existingTrack.enabled = !existingTrack.enabled;
      setIsCameraOff(!existingTrack.enabled);
      emitCameraState(existingTrack.enabled);
      return;
    }

    const pc = peerConnectionRef.current;
    const localStream = localStreamRef.current;
    const callId = callRef.current?.callId;
    if (!pc || !localStream || !callId || renegotiatingRef.current) return;
    renegotiatingRef.current = true;
    try {
      await ensureAndroidCallPermissions(false, true);
      const videoStream = await mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: {
            ideal: 640,
          },
          height: {
            ideal: 480,
          },
          frameRate: {
            ideal: 24,
            max: 30,
          },
        },
      });
      const videoTrack = videoStream.getVideoTracks()[0];
      if (!videoTrack) throw new Error("no video track from getUserMedia");
      localStream.addTrack(videoTrack);
      videoSenderRef.current = pc.addTrack(videoTrack, localStream);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      getSocket().emit("call:renegotiate-offer", {
        callId,
        sdp: pc.localDescription!.toJSON(),
        kind: "video",
      });

      setIsCameraOff(false);
      // A fresh getUserMedia call always starts on the front camera,
      // regardless of which one was active before the camera got turned off.
      setIsFrontCamera(true);
      setCall((prev) => (prev ? { ...prev, kind: "video" } : prev));
    } catch (err) {
      console.warn("[call] failed to enable camera", err);
      Alert.alert("Can't turn on camera", getUserMediaErrorMessage(err));
      renegotiatingRef.current = false;
    }
  }, [emitCameraState]);

  const switchCamera = useCallback(() => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    // _switchCamera is a react-native-webrtc extension, not part of the spec typings.
    (track as unknown as { _switchCamera?: () => void })?._switchCamera?.();
    // Only the front camera should mirror the local preview (it's meant to
    // feel like a real mirror); the back camera should show the true scene,
    // same as what the peer already sees — mirroring never touches the
    // transmitted video, only how ActiveCallScreen renders our own preview.
    setIsFrontCamera((prev) => !prev);
  }, []);

  const emitScreenShareState = useCallback((sharing: boolean) => {
    const callId = callRef.current?.callId;
    if (!callId) return;
    getSocket().emit("call:screen-share-state", { callId, sharing });
  }, []);

  // Restores the video sender back to the camera track (or to nothing, if
  // the call never had one) and releases the capture stream — shared by the
  // manual "stop sharing" tap and the capture track's own "ended" event
  // (fired when the user stops the broadcast from the OS's UI/status bar
  // instead of ours).
  const stopScreenShare = useCallback(async () => {
    const cameraTrack = localStreamRef.current?.getVideoTracks()[0] ?? null;
    try {
      if (videoSenderRef.current) await videoSenderRef.current.replaceTrack(cameraTrack);
    } catch (err) {
      console.warn("[call] failed to restore camera track after screen share", err);
    }
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    setIsScreenSharing(false);
    emitScreenShareState(false);
  }, [emitScreenShareState]);

  // Screen sharing swaps the outgoing video sender's track between the
  // camera and a getDisplayMedia() capture rather than adding a second video
  // m-line — one video sender per call, whichever source is currently live.
  // Once that sender already exists, replaceTrack() is negotiation-free (no
  // SDP round-trip, unlike toggleCamera's very first addTrack), so starting/
  // stopping a share mid-call never re-triggers negotiationneeded. The
  // original camera track is never removed from localStreamRef's stream —
  // just no longer attached to the sender while sharing — so stopping a
  // share can restore it (and whatever mute/off state it was already in)
  // via stopScreenShare instead of re-acquiring the camera.
  const toggleScreenShare = useCallback(async () => {
    const pc = peerConnectionRef.current;
    const callId = callRef.current?.callId;
    if (!pc || !callId || screenShareTogglingRef.current) return;
    screenShareTogglingRef.current = true;

    try {
      if (isScreenSharing) {
        await stopScreenShare();
        return;
      }

      const screenStream = await mediaDevices.getDisplayMedia();
      const screenTrack = screenStream.getVideoTracks()[0];
      if (!screenTrack) throw new Error("no video track from getDisplayMedia");

      // Re-checked after the getDisplayMedia await (the user could pick
      // "Cancel" and take a while doing it, or hang up entirely) — same
      // stale-attempt guard used throughout this file.
      if (callRef.current?.callId !== callId) {
        screenStream.getTracks().forEach((t) => t.stop());
        return;
      }

      if (videoSenderRef.current) {
        await videoSenderRef.current.replaceTrack(screenTrack);
      } else {
        // Audio-only call with no video sender yet — same addTrack +
        // renegotiate dance as toggleCamera's first-time-video branch.
        videoSenderRef.current = pc.addTrack(screenTrack, screenStream);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        getSocket().emit("call:renegotiate-offer", {
          callId,
          sdp: pc.localDescription!.toJSON(),
          kind: "video",
        });
        setCall((prev) => (prev ? { ...prev, kind: "video" } : prev));
      }

      screenStreamRef.current = screenStream;
      setIsScreenSharing(true);
      emitScreenShareState(true);

      // The extension/OS can end the broadcast out from under us (user taps
      // "Stop Broadcast" in the system UI/status bar rather than our own
      // button) — react-native-webrtc still surfaces that as the capture
      // track ending, same as any other track's "ended" event. Cast around
      // the same event-target-shim typing gap as the pc addEventListener
      // calls above (addEventListener works fine at runtime).
      (screenTrack as unknown as { addEventListener(type: "ended", listener: () => void): void }).addEventListener(
        "ended",
        () => {
          if (screenStreamRef.current !== screenStream) return;
          void stopScreenShare();
        }
      );
    } catch (err) {
      console.warn("[call] failed to toggle screen share", err);
    } finally {
      screenShareTogglingRef.current = false;
    }
  }, [emitScreenShareState, isScreenSharing, stopScreenShare]);

  const value = useMemo<CallContextValue>(
    () => ({
      phase,
      call,
      localStreamURL,
      remoteStreamURL,
      isMuted,
      isRemoteMuted,
      isSpeakerOn,
      isCameraOff,
      isRemoteCameraOff,
      isScreenSharing,
      isRemoteScreenSharing,
      isFrontCamera,
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
      toggleScreenShare,
    }),
    [
      phase,
      call,
      localStreamURL,
      remoteStreamURL,
      isMuted,
      isRemoteMuted,
      isSpeakerOn,
      isCameraOff,
      isRemoteCameraOff,
      isScreenSharing,
      isRemoteScreenSharing,
      isFrontCamera,
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
      toggleScreenShare,
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
