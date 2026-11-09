package com.neomambi.pasalo

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.PowerManager
import android.provider.OpenableColumns
import android.provider.Settings
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResult
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

/**
 * Lo que la parte en Rust no puede hacer sola en Android (ver `src/android.rs`).
 */
@InvokeArg
class SecureArgs {
  var on: Boolean = false
}

@InvokeArg
class CallAudioArgs {
  var on: Boolean = false
  var speaker: Boolean = false
}

@InvokeArg
class KeepAliveArgs {
  var on: Boolean = false
  var media: Int = PasaloService.MEDIA_NONE
}

@InvokeArg
class LocalNetworkArgs {
  var ask: Boolean = false
}

@InvokeArg
class OpenFolderArgs {
  var path: String = ""
}

@InvokeArg
class PermissionArgs {
  var id: String = ""
}

@InvokeArg
class NotifyMessageArgs {
  var peer: String = ""
  var name: String = ""
  var text: String = ""
}

@InvokeArg
class NotifyCallArgs {
  var call: String = ""
  var peer: String = ""
  var name: String = ""
  var video: Boolean = false
  var title: String = ""
}

@InvokeArg
class NotifyClearArgs {
  var call: String? = null
  var peer: String? = null
}

@TauriPlugin(permissions = [Permission(strings = [android.Manifest.permission.RECORD_AUDIO], alias = "microphone")])
class PasaloPlugin(private val activity: Activity) : Plugin(activity) {
  private var webView: WebView? = null
  /** Lo compartido desde otra app, ya copiado, hasta que la página lo recoge. */
  @Volatile private var shared: JSObject? = null
  private var multicastLock: WifiManager.MulticastLock? = null
  /** Apaga la pantalla al acercar el teléfono a la cara, como en cualquier llamada. */
  private var proximityLock: PowerManager.WakeLock? = null

  override fun load(webView: WebView) {
    // Sin este lock Android descarta los broadcasts UDP y no se ven los equipos de la LAN.
    val wifi = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    multicastLock = wifi.createMulticastLock("pasalo").apply {
      setReferenceCounted(false)
      acquire()
    }
    requestLocalNetwork()
    cleanOldCopies()
    passInsetsToPage(webView)
    handleBack(webView)
    this.webView = webView
    current = this
    // Abierta desde «Compartir» o desde una notificación con la app cerrada.
    takeShareIntent(activity.intent)
    takeNotificationIntent(activity.intent)
  }

  override fun onNewIntent(intent: Intent) {
    takeShareIntent(intent)
    takeNotificationIntent(intent)
  }

  // ---------- permisos (la sección de Ajustes, ver permissions.js) ----------

  /** Permiso de Android de cada uno de la lista, si lo es (los otros son ajustes). */
  private fun manifestPermission(id: String) = when (id) {
    "notifications" -> if (Build.VERSION.SDK_INT >= 33) android.Manifest.permission.POST_NOTIFICATIONS else null
    "microphone" -> android.Manifest.permission.RECORD_AUDIO
    "camera" -> android.Manifest.permission.CAMERA
    "local_network" -> LOCAL_NETWORK
    else -> null
  }

  private fun granted(permission: String) =
    ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED

  /** `granted`, `ask` (se puede pedir) o `denied` (ya solo desde los ajustes). */
  private fun permissionState(id: String): String {
    val ok = when (id) {
      "notifications" -> androidx.core.app.NotificationManagerCompat.from(activity).areNotificationsEnabled()
      "full_screen" -> Build.VERSION.SDK_INT < 34 ||
        activity.getSystemService(android.app.NotificationManager::class.java).canUseFullScreenIntent()
      "battery" -> (activity.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(activity.packageName)
      else -> granted(manifestPermission(id)!!)
    }
    if (ok) return "granted"
    val permission = manifestPermission(id) ?: return "ask"
    // Los que ya se pidieron antes de esta lista (al arrancar o al conectarse).
    val before = when (id) {
      "notifications" -> "asked_notifications"
      "local_network" -> "asked_local_network"
      else -> ""
    }
    val asked = prefs().getBoolean("asked_$permission", false) || prefs().getBoolean(before, false)
    return if (asked && !ActivityCompat.shouldShowRequestPermissionRationale(activity, permission)) "denied" else "ask"
  }

  @Command
  fun permissions(invoke: Invoke) {
    val ids = mutableListOf("notifications", "microphone", "camera")
    if (Build.VERSION.SDK_INT >= 34) ids += "full_screen"
    if (Build.VERSION.SDK_INT >= 37) ids += "local_network"
    ids += "battery"
    val list = JSArray()
    for (id in ids) list.put(JSObject().put("id", id).put("state", permissionState(id)))
    invoke.resolve(JSObject().put("list", list))
  }

  /** Lo pide al sistema o, si ya no se puede, abre la pantalla de ajustes donde se concede. */
  @Command
  fun requestPermission(invoke: Invoke) {
    val id = invoke.parseArgs(PermissionArgs::class.java).id
    val pkg = Uri.fromParts("package", activity.packageName, null)
    val permission = manifestPermission(id)
    val intent = when {
      permission != null && permissionState(id) == "ask" -> {
        ActivityCompat.requestPermissions(activity, arrayOf(permission), 4648)
        prefs().edit().putBoolean("asked_$permission", true).apply()
        null
      }
      id == "notifications" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
      id == "full_screen" -> Intent("android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT", pkg)
      id == "battery" -> Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg)
      else -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
    }
    if (intent != null) {
      try {
        activity.startActivity(intent)
      } catch (_: Exception) {
        activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg))
      }
    }
    invoke.resolve()
  }

  // ---------- notificaciones (ver Notifications.kt) ----------

  /** Lo tocado en una notificación antes de que existiera la página. */
  @Volatile private var pendingNotification: JSObject? = null

  private fun takeNotificationIntent(intent: Intent?) {
    when (intent?.action) {
      Notifications.ACTION_OPEN -> intent.getStringExtra(Notifications.EXTRA_PEER)?.let { deliver("open", peer = it) }
      Notifications.ACTION_ANSWER -> intent.getStringExtra(Notifications.EXTRA_CALL)?.let { deliver("answer", call = it) }
      else -> return
    }
    intent.action = Intent.ACTION_MAIN
  }

  private fun deliver(action: String, peer: String? = null, call: String? = null) {
    val payload = JSObject().put("action", action).put("peer", peer).put("call", call)
    pendingNotification = payload
    activity.runOnUiThread {
      webView?.evaluateJavascript("typeof pasaloNotification === 'function' && (pasaloNotification($payload), true)") { done ->
        if (done == "true") pendingNotification = null
      }
    }
  }

  @Command
  fun takeNotification(invoke: Invoke) {
    val out = pendingNotification ?: JSObject()
    pendingNotification = null
    invoke.resolve(out)
  }

  @Command
  fun notifyMessage(invoke: Invoke) {
    val args = invoke.parseArgs(NotifyMessageArgs::class.java)
    Notifications.message(activity, args.peer, args.name, args.text)
    invoke.resolve()
  }

  @Command
  fun notifyCall(invoke: Invoke) {
    val args = invoke.parseArgs(NotifyCallArgs::class.java)
    Notifications.call(activity, args.call, args.peer, args.name, args.video, args.title)
    invoke.resolve()
  }

  @Command
  fun notifyClear(invoke: Invoke) {
    val args = invoke.parseArgs(NotifyClearArgs::class.java)
    Notifications.clear(activity, args.call != null, args.peer)
    invoke.resolve()
  }

  /**
   * Lo que llega por «Compartir» (una o varias URIs, o solo texto) se copia
   * como lo elegido con `pickFiles` y se avisa a la página (`pasaloShare`),
   * que pregunta a quién enviarlo y lo recoge con `takeShare`.
   */
  private fun takeShareIntent(intent: Intent?) {
    if (intent == null || (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE)) return
    val uris = mutableListOf<Uri>()
    @Suppress("DEPRECATION")
    if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.addAll(it) }
    } else {
      intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.add(it) }
    }
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty()
    // Que no se vuelva a enviar si la actividad se recrea con el mismo intent.
    intent.action = Intent.ACTION_MAIN
    if (uris.isEmpty() && text.isBlank()) return
    Thread {
      val paths = JSArray()
      try {
        val dir = File(copiesDir(), System.currentTimeMillis().toString()).apply { mkdirs() }
        for (uri in uris) paths.put(copyToCache(uri, dir).absolutePath)
      } catch (e: Exception) {
        android.util.Log.w("pasalo", "no se pudo copiar lo compartido", e)
      }
      // Nada copiado: la página avisa (sin el permiso de la otra app, p. ej.).
      val failed = paths.length() < uris.size
      shared = JSObject().put("paths", paths).put("text", text).put("failed", failed)
      activity.runOnUiThread {
        webView?.evaluateJavascript("typeof pasaloShare === 'function' && pasaloShare()", null)
      }
    }.start()
  }

  @Command
  fun takeShare(invoke: Invoke) {
    val out = shared ?: JSObject().put("paths", JSArray()).put("text", "")
    shared = null
    invoke.resolve(out)
  }

  /**
   * Atrás cierra lo que haya abierto en la página (diálogo, ajustes, chat…) y,
   * si no hay nada, manda la app al fondo. Sin esto Android destruye la
   * actividad y el WebView se recarga entero: se perdía lo que había en
   * pantalla y la conexión con la pareja.
   */
  private fun handleBack(webView: WebView) {
    val owner = activity as? ComponentActivity ?: return
    owner.onBackPressedDispatcher.addCallback(owner, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript("typeof pasaloBack === 'function' && pasaloBack()") { handled ->
          if (handled != "true") activity.moveTaskToBack(true)
        }
      }
    })
  }

  /**
   * La app dibuja bajo las barras del sistema (Android 15+) y el teclado ya no
   * encoge la página, así que se le dice cuánto ocupan con las variables CSS
   * `--kb` (teclado) y `--nav` (barra de navegación).
   */
  private fun passInsetsToPage(webView: WebView) {
    // Antes de Android 11 la ventana no va bajo las barras (MainActivity) y
    // el teclado la encoge: no hay nada que restar.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
    // En el contenedor y no en el WebView: Tauri tiene su propio listener en
    // el WebView (el margen de la barra de estado) y no hay que pisarlo. El
    // contenedor pasa los insets intactos a sus hijos.
    val container = webView.parent as? android.view.View ?: webView
    ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
      val density = view.resources.displayMetrics.density
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom / density
      val nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom / density
      // La barra de estado: en algunos equipos (Android 16 de borde a borde)
      // el WebView no da `env(safe-area-inset-top)` y lo de arriba (p. ej. el
      // botón de calidad de la llamada) quedaba debajo de ella. Si el WebView
      // ya empieza por debajo (margen de Tauri), se descuenta.
      val location = IntArray(2)
      webView.getLocationInWindow(location)
      val status = insets.getInsets(WindowInsetsCompat.Type.statusBars()).top / density
      val top = maxOf(0f, status - location[1] / density)
      webView.evaluateJavascript(
        // Puede llegar antes de que exista la página: entonces no hace nada.
        "if(document.documentElement){var s=document.documentElement.style;s.setProperty('--kb','${ime}px');" +
          "s.setProperty('--nav-bar','${nav}px');s.setProperty('--sys-top','${top}px');}",
        null,
      )
      insets
    }
    ViewCompat.requestApplyInsets(container)
  }

  /** Micrófono para las llamadas de voz (las de WebRTC lo pide el WebView). */
  @Command
  fun requestAudio(invoke: Invoke) {
    if (ContextCompat.checkSelfPermission(activity, android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
      invoke.resolve(JSObject().put("granted", true))
    } else {
      requestPermissionForAlias("microphone", invoke, "audioPermissionResult")
    }
  }

  @PermissionCallback
  fun audioPermissionResult(invoke: Invoke) {
    val granted = ContextCompat.checkSelfPermission(activity, android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    invoke.resolve(JSObject().put("granted", granted))
  }

  /**
   * Pantalla protegida mientras se ve una foto de una sola vez: sin capturas
   * ni grabación de pantalla, y en negro en las apps recientes.
   */
  @Command
  fun secure(invoke: Invoke) {
    val args = invoke.parseArgs(SecureArgs::class.java)
    activity.runOnUiThread {
      val flag = android.view.WindowManager.LayoutParams.FLAG_SECURE
      if (args.on) activity.window.addFlags(flag) else activity.window.clearFlags(flag)
      invoke.resolve()
    }
  }

  /**
   * Modo de llamada: el sistema enruta por el auricular (o el altavoz) y aplica
   * su procesado de voz, que quita gran parte del eco.
   */
  @Command
  fun callAudio(invoke: Invoke) {
    val args = invoke.parseArgs(CallAudioArgs::class.java)
    val audio = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    audio.mode = if (args.on) AudioManager.MODE_IN_COMMUNICATION else AudioManager.MODE_NORMAL
    @Suppress("DEPRECATION")
    audio.isSpeakerphoneOn = args.on && args.speaker
    // Solo con el auricular: con el altavoz (o en vídeo) se mira la pantalla.
    setProximity(args.on && !args.speaker)
    invoke.resolve()
  }

  /**
   * Mantiene el proceso vivo (servicio en primer plano) mientras está en línea
   * o en una llamada. La primera vez pide permiso para la notificación.
   */
  @Command
  fun keepAlive(invoke: Invoke) {
    val args = invoke.parseArgs(KeepAliveArgs::class.java)
    if (args.on) {
      if (Build.VERSION.SDK_INT >= 33 &&
        ContextCompat.checkSelfPermission(activity, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
        !prefs().getBoolean("asked_notifications", false)
      ) {
        ActivityCompat.requestPermissions(activity, arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 4647)
        prefs().edit().putBoolean("asked_notifications", true).apply()
      }
      PasaloService.start(activity, args.media)
    } else {
      PasaloService.stop(activity)
    }
    invoke.resolve()
  }

  private fun setProximity(on: Boolean) {
    val power = activity.getSystemService(Context.POWER_SERVICE) as PowerManager
    if (on) {
      if (proximityLock?.isHeld == true || !power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return
      proximityLock = power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "pasalo:proximity").apply {
        setReferenceCounted(false)
        acquire(4 * 60 * 60 * 1000L)
      }
    } else {
      // Si se suelta con la cara aún cerca, la pantalla vuelve al alejarla.
      proximityLock?.let { if (it.isHeld) it.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY) }
      proximityLock = null
    }
  }

  /** Desde Android 17, sin este permiso no se ve ni se llega a ningún equipo de la LAN. */
  private fun requestLocalNetwork() {
    if (hasLocalNetwork()) return
    ActivityCompat.requestPermissions(activity, arrayOf(LOCAL_NETWORK), 4645)
    prefs().edit().putBoolean("asked_local_network", true).apply()
  }

  private fun hasLocalNetwork() =
    Build.VERSION.SDK_INT < 37 || ContextCompat.checkSelfPermission(activity, LOCAL_NETWORK) == PackageManager.PERMISSION_GRANTED

  private fun prefs() = activity.getSharedPreferences("pasalo", Context.MODE_PRIVATE)

  /**
   * Dice si hay permiso de red local y, con `ask`, lo pide. Si ya se negó
   * para siempre, Android no vuelve a preguntar: entonces se abren los
   * ajustes de la app para concederlo a mano.
   */
  @Command
  fun localNetwork(invoke: Invoke) {
    val args = invoke.parseArgs(LocalNetworkArgs::class.java)
    if (hasLocalNetwork() || !args.ask) {
      invoke.resolve(JSObject().put("granted", hasLocalNetwork()))
      return
    }
    val asked = prefs().getBoolean("asked_local_network", false)
    if (asked && !ActivityCompat.shouldShowRequestPermissionRationale(activity, LOCAL_NETWORK)) {
      val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null))
      activity.startActivity(intent)
    } else {
      requestLocalNetwork()
    }
    invoke.resolve(JSObject().put("granted", false))
  }

  companion object {
    private const val LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"

    /** El plugin en marcha, para lo que llega de fuera (el «Rechazar» de la notificación). */
    @Volatile private var current: PasaloPlugin? = null

    fun notificationAction(action: String, peer: String? = null, call: String? = null) {
      current?.deliver(action, peer, call)
    }
  }

  /**
   * Abre una carpeta (p. ej. `Download/Pasalo`) en la app de archivos del
   * sistema. Si no hay ninguna que abra carpetas, la lista de descargas.
   */
  @Command
  fun openFolder(invoke: Invoke) {
    val args = invoke.parseArgs(OpenFolderArgs::class.java)
    val root = "/storage/emulated/0/"
    val intents = mutableListOf<Intent>()
    if (args.path.startsWith(root)) {
      val doc = "primary:" + args.path.removePrefix(root).trimEnd('/')
      val uri = android.provider.DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", doc)
      intents += Intent(Intent.ACTION_VIEW).setDataAndType(uri, android.provider.DocumentsContract.Document.MIME_TYPE_DIR)
    }
    intents += Intent(android.app.DownloadManager.ACTION_VIEW_DOWNLOADS)
    for (intent in intents) {
      // Sin pedir permisos sobre la URI: no es nuestra, y Android lo rechaza.
      try {
        activity.startActivity(intent)
        invoke.resolve(JSObject().put("granted", true))
        return
      } catch (_: Exception) {
      }
    }
    invoke.resolve(JSObject().put("granted", false))
  }

  @Command
  fun pickFiles(invoke: Invoke) {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
    }
    startActivityForResult(invoke, intent, "pickFilesResult")
  }

  @ActivityCallback
  fun pickFilesResult(invoke: Invoke, result: ActivityResult) {
    val data = result.data
    if (result.resultCode != Activity.RESULT_OK || data == null) {
      invoke.resolve(JSObject().put("paths", JSArray()))
      return
    }
    val uris = mutableListOf<Uri>()
    val clip = data.clipData
    if (clip != null) {
      for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri)
    } else {
      data.data?.let { uris.add(it) }
    }
    // Copiar puede tardar con archivos grandes: fuera del hilo principal.
    Thread {
      try {
        val dir = File(copiesDir(), System.currentTimeMillis().toString()).apply { mkdirs() }
        val paths = JSArray()
        for (uri in uris) paths.put(copyToCache(uri, dir).absolutePath)
        invoke.resolve(JSObject().put("paths", paths))
      } catch (e: Exception) {
        // El texto lo pone la interfaz, en el idioma elegido (error `pick_failed`).
        invoke.reject(e.message ?: e.javaClass.simpleName)
      }
    }.start()
  }

  /** Rust solo sabe leer rutas, no `content://`: se envía una copia con el mismo nombre y fecha. */
  private fun copyToCache(uri: Uri, dir: File): File {
    val resolver = activity.contentResolver
    var name = "archivo"
    var modified = 0L
    resolver.query(uri, null, null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) {
        val nameCol = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (nameCol >= 0) cursor.getString(nameCol)?.let { name = it }
        val modCol = cursor.getColumnIndex("last_modified")
        if (modCol >= 0) modified = cursor.getLong(modCol)
      }
    }
    var file = File(dir, name.replace('/', '_'))
    var n = 1
    while (file.exists()) file = File(dir, "${n++} - $name")
    resolver.openInputStream(uri)!!.use { input -> file.outputStream().use { input.copyTo(it, 256 * 1024) } }
    if (modified > 0) file.setLastModified(modified)
    return file
  }

  private fun copiesDir() = File(activity.cacheDir, "enviar")

  /** Las copias se guardan una semana para poder reanudar envíos pausados. */
  private fun cleanOldCopies() {
    val limit = System.currentTimeMillis() - 7L * 24 * 3600 * 1000
    copiesDir().listFiles()?.filter { it.lastModified() < limit }?.forEach { it.deleteRecursively() }
  }
}
