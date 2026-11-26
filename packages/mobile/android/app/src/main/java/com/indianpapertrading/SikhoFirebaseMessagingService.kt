package com.indianpapertrading

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class SikhoFirebaseMessagingService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "SikhoFCM"
        const val CHANNEL_RELEASE_UPDATES = "release_updates"
        private const val PREFS_NAME = "sikho_device_prefs"
        private const val KEY_FCM_TOKEN = "fcm_token"

        fun createNotificationChannels(context: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = NotificationChannel(
                    CHANNEL_RELEASE_UPDATES,
                    "Release Updates",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "Important updates and announcements for Sikho Trading"
                    enableVibration(true)
                }
                val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                notificationManager?.createNotificationChannel(channel)
            }
        }

        fun getCachedToken(context: Context): String? {
            return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getString(KEY_FCM_TOKEN, null)
        }

        fun saveToken(context: Context, token: String) {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_FCM_TOKEN, token)
                .apply()
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels(this)
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.i(TAG, "New FCM registration token received: ${token.take(12)}...")
        saveToken(this, token)
        MainActivity.activeInstance?.onNewFcmToken(token)
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        Log.i(TAG, "FCM message received from: ${remoteMessage.from}")

        val title = remoteMessage.notification?.title
            ?: remoteMessage.data["title"]
            ?: "Sikho Trading Update Available"

        val body = remoteMessage.notification?.body
            ?: remoteMessage.data["message"]
            ?: "A new Sikho Trading update is available. Please update to continue."

        showReleaseNotification(title, body)
    }

    private fun showReleaseNotification(title: String, body: String) {
        createNotificationChannels(this)

        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("from_notification", true)
            putExtra("notification_channel", CHANNEL_RELEASE_UPDATES)
        }

        val pendingIntent = PendingIntent.getActivity(
            this,
            1001,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_RELEASE_UPDATES)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)

        try {
            val notificationManager = NotificationManagerCompat.from(this)
            notificationManager.notify(2001, builder.build())
        } catch (e: SecurityException) {
            Log.w(TAG, "Notification permission missing on Android 13+: ${e.message}")
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to display notification: ${t.message}", t)
        }
    }
}
