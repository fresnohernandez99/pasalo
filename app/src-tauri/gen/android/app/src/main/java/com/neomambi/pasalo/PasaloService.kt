package com.neomambi.pasalo

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
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Servicio en primer plano mientras Pasalo está en línea o en una llamada:
 * sin él Android mata el proceso en segundo plano y se pierden la conexión y
 * el código de iroh. La notificación trae «Cerrar», que cierra la app entera.
 */
class PasaloService : Service() {
  companion object {
    private const val CHANNEL = "pasalo_online"
    private const val NOTIFICATION = 4645
    private const val ACTION_CLOSE = "com.neomambi.pasalo.CLOSE"
    private const val EXTRA_MEDIA = "media"

    /** Llamada en marcha: 0 ninguna, 1 de voz, 2 de vídeo. */
    const val MEDIA_NONE = 0
    const val MEDIA_VOICE = 1
    const val MEDIA_VIDEO = 2

    fun start(context: Context, media: Int) {
      val intent = Intent(context, PasaloService::class.java).putExtra(EXTRA_MEDIA, media)
      ContextCompat.startForegroundService(context, intent)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, PasaloService::class.java))
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_CLOSE) {
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      stopSelf()
      android.os.Process.killProcess(android.os.Process.myPid())
      return START_NOT_STICKY
    }
    val media = intent?.getIntExtra(EXTRA_MEDIA, MEDIA_NONE) ?: MEDIA_NONE
    val notification = notification(media)
    try {
      ServiceCompat.startForeground(this, NOTIFICATION, notification, types(media))
    } catch (e: Exception) {
      // Sin permiso de cámara o micrófono (o arrancado en segundo plano): al
      // menos se mantiene la conexión.
      ServiceCompat.startForeground(this, NOTIFICATION, notification, types(MEDIA_NONE))
    }
    return START_NOT_STICKY
  }

  // En una llamada también micrófono (y cámara): si no, Android los corta al
  // salir de la app o apagar la pantalla.
  private fun types(media: Int): Int {
    if (Build.VERSION.SDK_INT < 34) return if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST else 0
    var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
    if (media >= MEDIA_VOICE) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    if (media >= MEDIA_VIDEO) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
    return types
  }

  private fun notification(media: Int): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
      val channel = NotificationChannel(CHANNEL, getString(R.string.service_channel), NotificationManager.IMPORTANCE_LOW)
      channel.setShowBadge(false)
      manager.createNotificationChannel(channel)
    }
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val open = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), flags
    )
    val close = PendingIntent.getService(
      this, 1, Intent(this, PasaloService::class.java).setAction(ACTION_CLOSE), flags
    )
    val text = getString(if (media == MEDIA_NONE) R.string.service_online else R.string.service_call)
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_pasalo)
      .setContentTitle(getString(R.string.app_name))
      .setContentText(text)
      .setContentIntent(open)
      .setOngoing(true)
      .setSilent(true)
      .setCategory(if (media == MEDIA_NONE) NotificationCompat.CATEGORY_SERVICE else NotificationCompat.CATEGORY_CALL)
      .addAction(0, getString(R.string.service_close), close)
      .build()
  }
}
