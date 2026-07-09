import { NativeModule, requireNativeModule } from "expo";

declare class ExpoCallPipModule extends NativeModule<{}> {
  /** True only where entering PiP is both a real OS capability and implemented here (Android 8+ today). */
  isSupported(): boolean;
  /** width/height describe the call view's aspect ratio for the floating window. Returns whether PiP was entered. */
  enterPipMode(width: number, height: number): boolean;
}

export default requireNativeModule<ExpoCallPipModule>("ExpoCallPip");
