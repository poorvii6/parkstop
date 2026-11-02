package expo.modules.parkstopnav

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import android.util.Rational

/**
 * Picture-in-picture (the floating mini-map) for navigation.
 *
 * While a route is active, leaving ParkStop (Home button / gesture) shrinks it
 * into a small floating window instead of hiding it — like Google Maps.
 *   Android 12+   the system does it automatically (setAutoEnterEnabled)
 *   Android 8-11  done by hand from onUserLeaveHint (NavPipLifecycleListener)
 */
object PipState {
  private const val TAG = "ParkstopNav"

  /** True while the driver is navigating. Set from JavaScript. */
  @Volatile
  var navigating: Boolean = false

  fun isSupported(activity: Activity?): Boolean {
    if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
    return activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
  }

  fun isInPip(activity: Activity?): Boolean {
    if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
    return activity.isInPictureInPictureMode
  }

  private fun buildParams(): PictureInPictureParams? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
    val builder = PictureInPictureParams.Builder()
      // Portrait window: road ahead plus the turn card above it.
      .setAspectRatio(Rational(3, 4))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setAutoEnterEnabled(navigating)
      builder.setSeamlessResizeEnabled(false)
    }
    return builder.build()
  }

  /** Push the current settings to the activity (turns auto-enter on/off). */
  fun apply(activity: Activity?) {
    if (activity == null || !isSupported(activity)) return
    val params = buildParams() ?: return
    try {
      activity.setPictureInPictureParams(params)
    } catch (e: Exception) {
      // Thrown if the activity is not declared supportsPictureInPicture.
      Log.w(TAG, "setPictureInPictureParams failed: ${e.message}")
    }
  }

  /** Enter the mini-map now. Returns true if the system accepted it. */
  fun enter(activity: Activity?): Boolean {
    if (activity == null || !isSupported(activity)) return false
    val params = buildParams() ?: return false
    return try {
      activity.enterPictureInPictureMode(params)
    } catch (e: Exception) {
      Log.w(TAG, "enterPictureInPictureMode failed: ${e.message}")
      false
    }
  }
}
