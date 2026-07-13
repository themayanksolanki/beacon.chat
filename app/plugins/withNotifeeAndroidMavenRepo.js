const { withProjectBuildGradle } = require("expo/config-plugins");

// @notifee/react-native ships its `core` AAR in its own bundled local maven
// repo (node_modules/@notifee/react-native/android/libs) rather than a
// public one, and normally self-registers that repo via a `rootProject
// .allprojects { repositories {...} }` block inside its own build.gradle.
// That self-registration is unreliable under `expo run:android`'s
// `--configure-on-demand` flag — :app's dependency resolution can run
// before notifee's own build.gradle has been evaluated, so the repo isn't
// registered yet and `app.notifee:core` fails to resolve. Registering it
// explicitly here, in the root project's own repositories block (evaluated
// up front, before configure-on-demand's lazy subproject configuration),
// fixes that ordering problem.
module.exports = function withNotifeeAndroidMavenRepo(config) {
  return withProjectBuildGradle(config, (config) => {
    const marker = "maven { url \"$rootDir/../node_modules/@notifee/react-native/android/libs\" }";
    if (config.modResults.contents.includes(marker)) return config;

    config.modResults.contents = config.modResults.contents.replace(
      /allprojects\s*{\s*repositories\s*{/,
      (match) => `${match}\n    ${marker}`
    );
    return config;
  });
};
