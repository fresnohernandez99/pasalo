package com.neomambi.pasalo

import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // Antes de Android 11 no hay insets de verdad del teclado (androidx los
    // estima) y la barra de navegación tapaba el chat y las pestañas (Redmi
    // 9A, Android 10). Ahí la ventana queda entre las barras, como siempre, y
    // el teclado la encoge (adjustResize): la página no tiene que restar nada.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      WindowCompat.setDecorFitsSystemWindows(window, true)
    }
    super.onCreate(savedInstanceState)
  }
}
