package expo.modules.parkstopnav

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps navigation alive when ParkStop is not on screen.
 *
 * Android cuts a backgrounded app's GPS down to a few fixes per hour. A
 * foreground service of type "location" — started while the app is open —
 * keeps full-rate GPS, the route progress and the voice going, and shows the
 * driver an ongoing "ParkStop · Turn right in 200 m" notification. Tapping it
 * brings ParkStop back.
 */
class NavForegroundService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "ParkStop navigation"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: ""
    val notification = buildNotification(this, title, text)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: Exception) {
      // e.g. location permission withdrawn. Navigation still works while the
      // app is open; it just won't continue in the background.
      Log.w(TAG, "startForeground failed: ${e.message}")
      running = false
      stopSelf()
    }
    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Driver swiped ParkStop away: end navigation with it.
    running = false
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  companion object {
    private const val TAG = "ParkstopNav"
    private const val CHANNEL_ID = "parkstop_navigation"
    private const val NOTIFICATION_ID = 7301
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_TEXT = "text"

    @Volatile
    var running: Boolean = false

    fun start(context: Context, title: String, text: String): Boolean {
      ensureChannel(context)
      val intent = Intent(context, NavForegroundService::class.java)
        .putExtra(EXTRA_TITLE, title)
        .putExtra(EXTRA_TEXT, text)
      return try {
        ContextCompat.startForegroundService(context, intent)
        running = true
        true
      } catch (e: Exception) {
        Log.w(TAG, "startForegroundService failed: ${e.message}")
        false
      }
    }

    /** Refresh the notification text. Cheap; does not restart the service. */
    fun update(context: Context, title: String, text: String) {
      if (!running) return
      ensureChannel(context)
      try {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification(context, title, text))
      } catch (e: Exception) {
        Log.w(TAG, "notification update failed: ${e.message}")
      }
    }

    fun stop(context: Context) {
      running = false
      try {
        context.stopService(Intent(context, NavForegroundService::class.java))
      } catch (e: Exception) {
        Log.w(TAG, "stopService failed: ${e.message}")
      }
    }

    private fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (nm.getNotificationChannel(CHANNEL_ID) != null) return
      val channel = NotificationChannel(CHANNEL_ID, "Navigation", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Turn-by-turn directions while ParkStop is navigating"
        setShowBadge(false)
        setSound(null, null)
        enableVibration(false)
      }
      nm.createNotificationChannel(channel)
    }

    private fun buildNotification(context: Context, title: String, text: String): Notification {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      }
      val contentIntent = launch?.let {
        PendingIntent.getActivity(
          context,
          0,
          it,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
      }
      val builder = NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(context.applicationInfo.icon)
        .setContentTitle(title)
        .setContentText(text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(text))
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setShowWhen(false)
        .setCategory("navigation") // Notification.CATEGORY_NAVIGATION
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      if (contentIntent != null) builder.setContentIntent(contentIntent)
      return builder.build()
    }
  }
}
