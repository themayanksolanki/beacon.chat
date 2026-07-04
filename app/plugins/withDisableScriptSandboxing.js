const { withXcodeProject } = require("expo/config-plugins");

// Xcode's "User Script Sandboxing" (default on in recent Xcode) blocks the
// RN "Bundle React Native code and images" build phase from writing helper
// files (e.g. ip.txt for dev-client), failing physical-device builds with a
// sandbox deny error. Xcode always regenerates the pbxproj on prebuild, so
// this has to be reapplied as a plugin rather than a one-off manual edit.
module.exports = function withDisableScriptSandboxing(config) {
  return withXcodeProject(config, (config) => {
    config.modResults.updateBuildProperty("ENABLE_USER_SCRIPT_SANDBOXING", "NO");
    return config;
  });
};
