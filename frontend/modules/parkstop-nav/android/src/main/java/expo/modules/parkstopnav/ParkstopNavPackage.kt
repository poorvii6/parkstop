package expo.modules.parkstopnav

import android.content.Context
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/** Registers the activity hooks. Found by Expo autolinking via the *Package.kt name. */
class ParkstopNavPackage : Package {
  override fun createReactActivityLifecycleListeners(activityContext: Context?): List<ReactActivityLifecycleListener> {
    return listOf(NavPipLifecycleListener())
  }
}
