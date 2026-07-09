const { withAndroidManifest, AndroidConfig } = require("expo/config-plugins");

// Declarative prerequisites for Activity.enterPictureInPictureMode() (see
// modules/expo-call-pip) — without these two attributes the call is refused
// at runtime even though the method exists.
module.exports = function withAndroidPip(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);

    mainActivity.$["android:supportsPictureInPicture"] = "true";
    mainActivity.$["android:resizeableActivity"] = "true";

    return config;
  });
};
