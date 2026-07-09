package expo.modules.callpip

import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.os.Build
import android.util.Rational
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Bridges Activity.enterPictureInPictureMode() for the active-call screen.
// Android already refuses this call unless the manifest declares
// supportsPictureInPicture/resizeableActivity on the activity — see
// plugins/withAndroidPip.js, which sets those.
class ExpoCallPipModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoCallPip")

    Function("isSupported") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        false
      } else {
        appContext.reactContext?.packageManager
          ?.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE) == true
      }
    }

    // width/height describe the call view's current aspect ratio (e.g. the
    // remote video feed) so the floating window keeps the same proportions.
    Function("enterPipMode") { width: Int, height: Int ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        return@Function false
      }
      val activity = appContext.currentActivity ?: return@Function false

      // Rational requires both terms to be positive and rejects extreme
      // ratios (Android caps it to roughly 2.39:1); clamping keeps a bad
      // width/height from throwing instead of just falling back to 1:1-ish.
      val safeWidth = width.coerceIn(1, 1000)
      val safeHeight = height.coerceIn(1, 1000)
      val params = PictureInPictureParams.Builder()
        .setAspectRatio(Rational(safeWidth, safeHeight))
        .build()

      try {
        activity.enterPictureInPictureMode(params)
      } catch (_: Exception) {
        false
      }
    }
  }
}
