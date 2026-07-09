const { withAndroidManifest, AndroidConfig } = require("expo/config-plugins");

// react-native-callkeep's Android side is a self-managed ConnectionService:
// the app supplies its own call UI, but the OS's Telecom framework still
// needs a <service> entry declared in the app's own manifest (the library's
// AAR only ships the compiled VoiceConnectionService class, not the manifest
// entry) so Android knows to route call-waiting/audio-focus arbitration
// against this app's calls. See docs/android-installation.md in
// react-native-webrtc/react-native-callkeep.
const SERVICE_NAME = "io.wazo.callkeep.VoiceConnectionService";

module.exports = function withCallKeepAndroid(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);

    mainApplication.service = mainApplication.service ?? [];
    const alreadyPresent = mainApplication.service.some(
      (service) => service.$?.["android:name"] === SERVICE_NAME
    );

    if (!alreadyPresent) {
      mainApplication.service.push({
        $: {
          "android:name": SERVICE_NAME,
          "android:label": "Beacon",
          "android:permission": "android.permission.BIND_TELECOM_CONNECTION_SERVICE",
          // Android 11-13 want "phoneCall"; 14+ additionally wants the
          // per-resource-type flags. Declaring all three covers the range of
          // OS versions this app can run on without needing per-version
          // manifest logic.
          "android:foregroundServiceType": "camera|microphone|phoneCall",
          // Required on Android 12+ for any component with an intent-filter.
          "android:exported": "true",
        },
        "intent-filter": [
          {
            action: [{ $: { "android:name": "android.telecom.ConnectionService" } }],
          },
        ],
      });
    }

    return config;
  });
};
