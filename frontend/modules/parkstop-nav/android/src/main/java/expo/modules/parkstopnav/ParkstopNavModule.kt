package expo.modules.parkstopnav

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JavaScript bridge for ParkStop navigation on Android:
 *   - floating mini-map (picture-in-picture) while navigating
 *   - "ParkStop is navigating" notification that keeps GPS + voice running
 *     when the app is minimised or the screen is locked
 */
class ParkstopNavModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ParkstopNav")

    Function("isPipSupported") {
      PipState.isSupported(appContext.currentActivity)
    }

    Function("isInPictureInPicture") {
      PipState.isInPip(appContext.currentActivity)
    }

    /** Turn the automatic mini-map on while a route is active, off otherwise. */
    Function("setNavigationActive") { active: Boolean ->
      PipState.navigating = active
      val activity = appContext.currentActivity
      activity?.runOnUiThread { PipState.apply(activity) }
      Unit
    }

    Function("enterPictureInPicture") {
      PipState.enter(appContext.currentActivity)
    }

    Function("startNavNotification") { title: String, text: String ->
      val context = appContext.reactContext
      if (context == null) false else NavForegroundService.start(context, title, text)
    }

    Function("updateNavNotification") { title: String, text: String ->
      appContext.reactContext?.let { NavForegroundService.update(it, title, text) }
      Unit
    }

    Function("stopNavNotification") {
      appContext.reactContext?.let { NavForegroundService.stop(it) }
      Unit
    }
  }
}
