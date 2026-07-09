# Android CI (GitHub Actions)

Workflow file: [`.github/workflows/android-build.yml`](../.github/workflows/android-build.yml)

Builds installable debug/release APKs on every PR and push, for
development/testing distribution. This is separate from the existing EAS
Build setup (`app/eas.json`, the `expo-android:*` npm scripts) — EAS remains
the path for store submissions; this workflow is a fast, free,
GitHub-native path for a dev/test APK on every change.

## How it operates

**Triggers**: pull requests and pushes to `main` or `develop` that touch
`app/**` or this workflow file itself, plus manual runs
(`workflow_dispatch`, which always runs regardless of what changed). Backend
(`server/`)-only changes do not trigger this workflow.

**Why `expo prebuild` runs on every build**: this app is a managed Expo
project using Continuous Native Generation — `app/android` (and `app/ios`)
are gitignored and never committed. The workflow regenerates the native
Android project fresh every run via `npx expo prebuild --platform android`
before any Gradle command can work. All four of `app/plugins/*.js` (the
project's existing Expo config plugins, e.g. `withCallKeepAndroid.js` for
the Telecom manifest entry, plus the new `withAndroidReleaseSigning.js`
described below) run automatically as part of this step.

**Steps, in order**: checkout → Node 22 / Java 17 (Zulu) / Android SDK /
Gradle caching setup → `npm ci` → lint (if a `lint` script exists — none
does today, so this is currently a no-op) → unit tests (if a `test` script
exists — it does, via Jest) → `expo prebuild` → Debug APK build (always) →
Release APK build (only if signing secrets are configured) → artifact
uploads → optional Firebase App Distribution upload.

**Debug APK**: always built and uploaded, using the standard Expo/RN
debug keystore that `expo prebuild` generates automatically. No secrets
required.

**Release APK**: only attempted when all four `ANDROID_*` signing secrets
below are configured in the repo. If none are set, the release steps are
cleanly **skipped** (not failed) and only the Debug APK is produced. If
*some but not all four* are set, the workflow fails loudly with a clear
error — a partial secret set is treated as a misconfiguration worth
surfacing, not silently ignored.

**Fork PRs never get a release build.** GitHub Actions strips repository
secrets from `pull_request` runs triggered by forks, regardless of this
workflow's logic — the signing-secret check will correctly report
"unavailable" and only the Debug APK builds. This is expected, not a bug.

**How release signing is wired up**: the stock Expo/RN template hardcodes
the `release` build type to sign with the debug keystore, and
`app/android/app/build.gradle` is regenerated from scratch on every
`expo prebuild` run (it's gitignored), so a one-off manual edit would be
silently discarded. Instead, `app/plugins/withAndroidReleaseSigning.js` — a
new Expo config plugin registered in `app/app.json`, following the same
pattern as this project's other Android config plugins — appends a guarded
signing block to `build.gradle` at prebuild time. It only activates when
the CI workflow supplies `ORG_GRADLE_PROJECT_BEACON_RELEASE_*` environment
variables (Gradle's built-in mechanism for injecting project properties
without writing a properties file to disk); otherwise it's a no-op and
release keeps debug-signing exactly as the stock template does.

## Required GitHub Secrets

Configure these under **Settings → Secrets and variables → Actions** in the
GitHub repo.

| Secret | Required for | Description |
| --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Release APK | Your release `.jks`/`.keystore` file, base64-encoded. Generate with `base64 -i release.keystore \| pbcopy` (macOS) or `base64 -w0 release.keystore` (Linux), then paste the output as the secret value. |
| `ANDROID_KEYSTORE_PASSWORD` | Release APK | The keystore's store password. |
| `ANDROID_KEY_ALIAS` | Release APK | The key alias inside the keystore to sign with. |
| `ANDROID_KEY_PASSWORD` | Release APK | The password for that key alias (may be the same as the store password, depending on how the keystore was generated). |
| `FIREBASE_APP_ID` | Optional — Firebase App Distribution | The Android Firebase App ID (`appId`) from the Firebase console for this app. |
| `FIREBASE_SERVICE_CREDENTIALS_JSON` | Optional — Firebase App Distribution | The full JSON contents of a Firebase service account key with App Distribution permissions. |
| `FIREBASE_DISTRIBUTION_GROUPS` | Optional — Firebase App Distribution | Comma-separated tester group name(s) to distribute to. Defaults to `testers` if unset. |

All four `ANDROID_*` secrets must be set together for a signed Release APK
to build — see "How it operates" above for what happens with a partial set.
The three `FIREBASE_*` secrets are independently optional: without them, the
Release APK still builds and uploads as a GitHub Actions artifact, it just
isn't also pushed to Firebase App Distribution.

## How to manually trigger the workflow

1. Go to the repo's **Actions** tab on GitHub.
2. Select **Android APK Build** in the left sidebar.
3. Click **Run workflow**, choose the branch, and confirm.

Or via the GitHub CLI: `gh workflow run android-build.yml --ref <branch>`.

## How to download the built APKs

1. Open the workflow run (**Actions** tab → the run you want).
2. Scroll to the **Artifacts** section at the bottom of the run summary
   page.
3. Download `beacon-debug-apk` and/or `beacon-release-apk` (the latter only
   appears when signing secrets were configured for that run).
4. Artifacts are retained for 14 days, then automatically deleted.

## Extending this workflow

This was built to be a reasonable starting point, not a final shape:

- **AAB builds**: add a `./gradlew bundleRelease` step alongside
  `assembleRelease`, reusing the same signing properties and gate.
- **Product flavors**: turn the single job into a matrix
  (`strategy.matrix.flavor: [...]`) and parameterize the `assemble*` task
  names accordingly.
- **CD**: the Firebase App Distribution step is already a template for
  "upload the Release APK somewhere on success" — a Play Store internal
  track upload (e.g. `r0adkll/upload-google-play`) would slot in the same
  way, gated the same way.
- **Supply-chain hardening**: third-party actions here
  (`android-actions/setup-android`, `wzieba/Firebase-Distribution-Github-Action`)
  are pinned to major-version tags for readability. If this pipeline starts
  handling more sensitive signing material, consider pinning to full commit
  SHAs instead.
