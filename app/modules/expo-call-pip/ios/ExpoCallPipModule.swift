import ExpoModulesCore

// iOS picture-in-picture for a live WebRTC video call requires a custom
// AVPictureInPictureController fed by an AVSampleBufferDisplayLayer wired to
// the remote video track — meaningfully more native work than this module
// covers today. These stubs keep the JS-side API (isSupported/enterPipMode)
// safe to call unconditionally from any platform; ActiveCallScreen already
// treats `isSupported() === false` as "no PiP button here" rather than an
// error, so this is a real (if unimplemented) "not supported" answer.
public class ExpoCallPipModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoCallPip")

    Function("isSupported") { () -> Bool in
      false
    }

    Function("enterPipMode") { (_ width: Int, _ height: Int) -> Bool in
      false
    }
  }
}
