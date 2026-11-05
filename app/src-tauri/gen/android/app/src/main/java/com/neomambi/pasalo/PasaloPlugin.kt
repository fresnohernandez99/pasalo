package com.neomambi.pasalo

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.provider.OpenableColumns
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

/**
 * Lo que la parte en Rust no puede hacer sola en Android (ver `src/android.rs`).
 */
@TauriPlugin
class PasaloPlugin(private val activity: Activity) : Plugin(activity) {
  private var multicastLock: WifiManager.MulticastLock? = null

  override fun load(webView: WebView) {
    // Sin este lock Android descarta los broadcasts UDP y no se ven los equipos de la LAN.
    val wifi = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    multicastLock = wifi.createMulticastLock("pasalo").apply {
      setReferenceCounted(false)
      acquire()
    }
    requestLocalNetwork()
    cleanOldCopies()
  }

  /** Desde Android 17, sin este permiso no se ve ni se llega a ningún equipo de la LAN. */
  private fun requestLocalNetwork() {
    if (Build.VERSION.SDK_INT < 37) return
    val permission = "android.permission.ACCESS_LOCAL_NETWORK"
    if (ContextCompat.checkSelfPermission(activity, permission) != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(activity, arrayOf(permission), 4645)
    }
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
