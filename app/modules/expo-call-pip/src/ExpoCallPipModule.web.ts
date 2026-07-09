import { registerWebModule, NativeModule } from "expo";

// Browsers have their own PiP APIs (requestPictureInPicture on a <video>
// element) that don't map onto this native-Activity-style bridge; the app
// only targets iOS/Android for calling, so this is a plain "not supported."
class ExpoCallPipModule extends NativeModule<{}> {
  isSupported(): boolean {
    return false;
  }

  enterPipMode(_width: number, _height: number): boolean {
    return false;
  }
}

export default registerWebModule(ExpoCallPipModule, "ExpoCallPipModule");
