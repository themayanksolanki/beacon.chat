# iOS screen share: one-time Xcode setup (per prebuild)

Screen sharing on iOS needs a **Broadcast Upload Extension** — a second app
target that ReplayKit runs as a separate process to capture the screen, even
when Beacon itself is backgrounded. All the JS/TS wiring (CallContext,
ActiveCallScreen, the socket relay) is already in the repo, and so is the
extension's own source — but it lives at
`ios-extensions/BeaconScreenShare/{SampleHandler.swift, Info.plist,
BeaconScreenShare.entitlements}`, **not** under `ios/`.

That's deliberate: `npx expo prebuild -p ios` deletes and regenerates the
entire `ios/` folder **every time you run it, even without `--clean`**
(verified — it logs "Clearing ios" unconditionally). Anything placed
directly under `ios/` disappears on the next prebuild. A config plugin,
`plugins/withIosScreenShareExtension.js`, copies the three files above into
`ios/BeaconScreenShare/` as part of every prebuild, so they're always back
in place before you open Xcode — you never need to manually restore them.

What a config plugin *can't* do (safely, from here) is create and sign a
whole second Xcode target — that needs your Apple Developer account to
register an **App Group**, and scripting `.pbxproj` target/build-phase
creation blind, with no way to build-and-check it in Xcode, is too fragile
to trust. So: **the Xcode target itself has to be recreated by hand after
every `expo prebuild`, since prebuild always wipes it along with the rest of
`ios/`.** The steps below are quick (a few minutes) — do them once per
prebuild, right before you build/archive in Xcode.

Android needs none of this: `mediaDevices.getDisplayMedia()` drives Android's
MediaProjection permission flow directly, and the required foreground
service is already declared in react-native-webrtc's own manifest.

## Steps (redo after every `expo prebuild`)

1. Open `ios/Beacon.xcworkspace` in Xcode (not the `.xcodeproj`).

2. **File → New → Target…** → iOS → **Broadcast Upload Extension**.
   - Product Name: `BeaconScreenShare` (must match `RTCScreenSharingExtension`
     in `app.json`'s `ios.infoPlist`, minus the app's bundle id prefix — Xcode
     will produce `com.beaconchat.app.BeaconScreenShare`, which is what that
     key is already set to).
   - Language: Swift.
   - When asked "Include UI Extension?" say **No** — we only want the
     sample-buffer-processing half.
   - Finish. Xcode creates a new group/target with its own scaffolded
     `SampleHandler.swift` and `Info.plist` — the config plugin has already
     copied the *real* versions into `ios/BeaconScreenShare/` alongside them.

3. **Delete Xcode's scaffolded files** (`SampleHandler.swift` and `Info.plist`
   under the new `BeaconScreenShare` group — "Move to Trash"), then drag in
   the three files already sitting in `ios/BeaconScreenShare/` (in Finder):
   `SampleHandler.swift`, `Info.plist`, `BeaconScreenShare.entitlements`.
   In the add dialog, **uncheck** "Copy items if needed" (they're already in
   place) and make sure **target membership is `BeaconScreenShare` only**.

4. Select the `BeaconScreenShare` target → **General** tab → confirm Bundle
   Identifier is `com.beaconchat.app.BeaconScreenShare`.

5. Same target → **Signing & Capabilities**:
   - Set **Team** to your Apple Developer team; leave "Automatically manage
     signing" on.
   - **+ Capability → App Groups** → add and check `group.com.beaconchat.app`.
     This is the step that actually registers the App Group under your
     account — Xcode does it the moment you check the box (you need an
     active Apple Developer Program membership for this to succeed).
   - Under **Build Settings**, confirm "Code Signing Entitlements" points at
     `BeaconScreenShare/BeaconScreenShare.entitlements` (Xcode usually sets
     this automatically once you added the capability above; if it instead
     generated a *new* entitlements file, delete that one and repoint the
     build setting at the prepared file so the App Group id stays in sync
     with what `SampleHandler.swift` expects).

6. Select the main **Beacon** target → **Signing & Capabilities** → **+
   Capability → App Groups** → check the same `group.com.beaconchat.app`.
   (`app.json`'s `ios.entitlements` already puts this in
   `ios/Beacon/Beacon.entitlements` on every prebuild — checking it here in
   Xcode is what actually wires up signing/provisioning for it.)

7. Build and run **on a real device** — ReplayKit screen capture does not
   work in the iOS Simulator.

## Testing

Start a call, tap the new screen-share (monitor icon) control button in
`ActiveCallScreen`. This should pop the system "Start Broadcast" sheet with
**only "BeaconScreenShare" listed** — tap it. The peer should start seeing
your screen within about a second. Tapping the button again (or "Stop
Broadcast" from the OS status bar) ends the share and restores your camera
feed if the call was a video call.

If the picker instead shows a list of *other* apps (WhatsApp, ChatGPT,
whatever else on the device has a broadcast extension) and no Beacon entry,
that means ReplayKit's `preferredExtension` didn't resolve to an installed
extension — i.e. either `RTCScreenSharingExtension` in Info.plist doesn't
match an actually-installed extension's bundle id, or (much more likely) the
`BeaconScreenShare` target from the steps above was never built onto the
device at all. `RPSystemBroadcastPickerView` falls back to listing every
broadcast-capable app on the device whenever it can't find a match — it's
not filtering to "apps that support this," it's specifically failing to find
yours.

If the broadcast starts but the peer never sees anything: check that the
app group identifier agrees across `app.json` (`RTCAppGroupIdentifier` /
`ios.entitlements`), `ios-extensions/BeaconScreenShare/BeaconScreenShare.entitlements`,
and what's actually checked in Xcode's Signing & Capabilities for both
targets — `SampleHandler.swift`'s `appGroupIdentifier` constant has to agree
with all of them, and it hardcodes `group.com.beaconchat.app`.

## Why this can't be fully automated (yet)

This project builds iOS locally from Xcode, not via EAS/CI (a clean-checkout
CI build would have no way to run the manual Xcode steps above at all). If
that ever changes, the extension target itself would need to be generated
by a config plugin — scripting the `.pbxproj` to add the target, build
phases, and embed-extension step — which is a substantially bigger and
riskier undertaking to get right without being able to build-and-iterate in
Xcode directly, so it was deliberately left out of this pass.
