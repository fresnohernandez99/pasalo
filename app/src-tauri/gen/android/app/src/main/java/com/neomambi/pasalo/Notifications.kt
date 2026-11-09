package com.neomambi.pasalo

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person

/**
 * Notificaciones de los mensajes y las llamadas que llegan con la app en
 * segundo plano (las pide la interfaz, ver `notify.js`).
 *
 * Las llamadas usan lo que Android tiene para ellas: `CallStyle` (con
 * contestar y rechazar del sistema) y la notificación a pantalla completa,
 * que enciende la pantalla y se ve con el teléfono bloqueado. El timbre lo
 * pone la propia llamada en la página, así que el canal solo vibra.
 */
object Notifications {
  private const val MESSAGES = "pasalo_messages"
  private const val CALLS = "pasalo_calls"
  const val CALL_NOTIFICATION = 4700

  const val ACTION_OPEN = "com.neomambi.pasalo.OPEN_CHAT"
  const val ACTION_ANSWER = "com.neomambi.pasalo.ANSWER"
  const val ACTION_DECLINE = "com.neomambi.pasalo.DECLINE"
  const val EXTRA_PEER = "peer"
  const val EXTRA_CALL = "call"

  private fun channels(context: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = context.getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(MESSAGES) == null) {
      manager.createNotificationChannel(
        NotificationChannel(MESSAGES, context.getString(R.string.notify_messages), NotificationManager.IMPORTANCE_HIGH)
      )
    }
    if (manager.getNotificationChannel(CALLS) == null) {
      val channel = NotificationChannel(CALLS, context.getString(R.string.notify_calls), NotificationManager.IMPORTANCE_HIGH)
      channel.setSound(null, null)
      channel.enableVibration(true)
      channel.vibrationPattern = longArrayOf(0, 800, 600, 800, 600, 800)
      channel.lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
      manager.createNotificationChannel(channel)
    }
  }

  /** Cada chat tiene su notificación, que va juntando los mensajes que llegan. */
  private fun chatId(peer: String) = peer.hashCode()

  private fun openIntent(context: Context, action: String, extra: String, value: String, code: Int): PendingIntent {
    val intent = Intent(context, MainActivity::class.java)
      .setAction(action)
      .putExtra(extra, value)
      .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(context, code, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  fun message(context: Context, peer: String, name: String, text: String) {
    channels(context)
    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) return
    val id = chatId(peer)
    val sender = Person.Builder().setName(name).setKey(peer).build()
    // Los mensajes que ya estaban en la notificación siguen ahí.
    val previous = context.getSystemService(NotificationManager::class.java)
      .activeNotifications.firstOrNull { it.id == id }?.notification
    val style = previous?.let { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it) }
      ?: NotificationCompat.MessagingStyle(Person.Builder().setName(context.getString(R.string.notify_me)).build())
    style.addMessage(text, System.currentTimeMillis(), sender)
    val notification = NotificationCompat.Builder(context, MESSAGES)
      .setSmallIcon(R.drawable.ic_stat_pasalo)
      .setStyle(style)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setContentIntent(openIntent(context, ACTION_OPEN, EXTRA_PEER, peer, id))
      .setAutoCancel(true)
      .build()
    try {
      manager.notify(id, notification)
    } catch (_: SecurityException) {
      // Sin permiso de notificaciones (Android 13+).
    }
  }

  fun call(activity: Activity, call: String, peer: String, name: String, video: Boolean, title: String) {
    channels(activity)
    val manager = NotificationManagerCompat.from(activity)
    // Encima de la pantalla de bloqueo y encendiéndola, como cualquier llamada.
    showOverLock(activity, true)
    if (!manager.areNotificationsEnabled()) return
    val caller = Person.Builder().setName(name).setKey(peer).setImportant(true).build()
    val answer = openIntent(activity, ACTION_ANSWER, EXTRA_CALL, call, CALL_NOTIFICATION)
    val decline = PendingIntent.getBroadcast(
      activity, CALL_NOTIFICATION,
      Intent(activity, CallActionReceiver::class.java).setAction(ACTION_DECLINE).putExtra(EXTRA_CALL, call),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val ring = openIntent(activity, Intent.ACTION_MAIN, EXTRA_CALL, call, CALL_NOTIFICATION + 1)
    val builder = NotificationCompat.Builder(activity, CALLS)
      .setSmallIcon(R.drawable.ic_stat_pasalo)
      .setContentTitle(name)
      .setContentText(title)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setContentIntent(ring)
      .setTimeoutAfter(60_000)
    // Android 14+ solo deja la pantalla completa a las apps de llamadas o
    // alarmas que tengan el permiso; sin ella, `CallStyle` no se admite y va
    // como notificación normal con los mismos botones.
    val fullScreen = Build.VERSION.SDK_INT < 34 ||
      activity.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()
    if (fullScreen) {
      builder.setFullScreenIntent(ring, true)
      builder.setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer).setIsVideo(video))
    } else {
      builder.addAction(0, activity.getString(R.string.notify_decline), decline)
      builder.addAction(0, activity.getString(R.string.notify_answer), answer)
    }
    try {
      manager.notify(CALL_NOTIFICATION, builder.build())
    } catch (_: Exception) {
      // Sin permiso, o un sistema que rechaza el estilo: la llamada sigue en pantalla.
    }
  }

  /** Quita la de la llamada (`call`) o la del chat con `peer`. */
  fun clear(activity: Activity, call: Boolean, peer: String?) {
    val manager = NotificationManagerCompat.from(activity)
    if (call) {
      manager.cancel(CALL_NOTIFICATION)
      showOverLock(activity, false)
    }
    if (peer != null) manager.cancel(chatId(peer))
  }

  private fun showOverLock(activity: Activity, on: Boolean) {
    if (Build.VERSION.SDK_INT < 27) return
    activity.runOnUiThread {
      activity.setShowWhenLocked(on)
      activity.setTurnScreenOn(on)
    }
  }
}

/** «Rechazar» sin abrir la app: se lo pasa a la página. */
class CallActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val call = intent.getStringExtra(Notifications.EXTRA_CALL) ?: return
    NotificationManagerCompat.from(context).cancel(Notifications.CALL_NOTIFICATION)
    PasaloPlugin.notificationAction("decline", call = call)
  }
}
