const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("expo/config-plugins");

// `expo prebuild` fully deletes and regenerates ios/ every run (confirmed:
// even without --clean) — a hand-written extension's source files placed
// directly under ios/BeaconScreenShare would get wiped on the very next
// prebuild. Keeping the real copies in ios-extensions/ (outside the
// regenerated tree, tracked normally in git) and copying them into
// ios/BeaconScreenShare/ here means they're always back in place before you
// open Xcode, regardless of how many times prebuild has run since.
//
// This only restores the *source files* the Broadcast Upload Extension
// needs — it does not create the Xcode target itself (the .pbxproj entry,
// build phases, signing, App Group capability), which still has to be done
// by hand once per fresh ios/ folder. See docs/ios-screen-share-setup.md.
const SOURCE_DIR = path.join(__dirname, "..", "ios-extensions", "BeaconScreenShare");

module.exports = function withIosScreenShareExtension(config) {
  return withDangerousMod(config, [
    "ios",
    (config) => {
      const destDir = path.join(config.modRequest.platformProjectRoot, "BeaconScreenShare");
      fs.mkdirSync(destDir, { recursive: true });
      for (const fileName of fs.readdirSync(SOURCE_DIR)) {
        fs.copyFileSync(path.join(SOURCE_DIR, fileName), path.join(destDir, fileName));
      }
      return config;
    },
  ]);
};
