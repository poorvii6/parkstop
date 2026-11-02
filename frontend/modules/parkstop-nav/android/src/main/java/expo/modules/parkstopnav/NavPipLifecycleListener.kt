package expo.modules.parkstopnav

import android.app.Activity
import android.os.Build
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/**
 * Hooks into ParkStop's main activity without editing MainActivity itself.
 *
 * onUserLeaveHint fires when the driver presses Home. Android 12+ enters the
 * mini-map on its own (auto-enter), so this only acts on Android 8-11.
 */
class NavPipLifecycleListener : ReactActivityLifecycleListener {
  override fun onUserLeaveHint(activity: Activity?) {
    if (!PipState.navigating) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      PipState.enter(activity)
    }
  }

  override fun onResume(activity: Activity?) {
    // Re-apply after the activity is recreated so auto-enter stays in sync.
    PipState.apply(activity)
  }
}
