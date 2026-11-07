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

@TauriPlugin(permissions = [Permission(strings = [android.Manifest.permission.RECORD_AUDIO], alias = "microphone")])
class PasaloPlugin(private val activity: Activity) : Plugin(activity) {
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
    // En el contenedor y no en el WebView: Tauri tiene su propio listener en
    // el WebView (el margen de la barra de estado) y no hay que pisarlo. El
    // contenedor pasa los insets intactos a sus hijos.
    val container = webView.parent as? android.view.View ?: webView
    ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
      val density = view.resources.displayMetrics.density
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom / density
      val nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom / density
      webView.evaluateJavascript(
        // Puede llegar antes de que exista la página: entonces no hace nada.
        "if(document.documentElement){var s=document.documentElement.style;s.setProperty('--kb','${ime}px');" +
          "s.setProperty('--nav','${if (ime > 0) 0f else nav}px');}",
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
