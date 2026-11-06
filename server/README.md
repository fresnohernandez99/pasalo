# Server de conexión de Pasalo

Server de señalización para conectar equipos de redes distintas. Solo presenta a los equipos: muestra quién está conectado y lleva las solicitudes de conexión. Cuando alguien acepta una, cada lado recibe el código de iroh del otro, los dos se van del server y desde ese momento hablan directamente por iroh. Por el server no pasan archivos, mensajes ni llamadas.

Es una sola función para Vercel (`api/[action].js`) con MongoDB (pensado para MongoDB Atlas).

## Desplegar en Vercel

1. En MongoDB Atlas, crea un clúster (el gratuito M0 basta) y un usuario de base de datos. En **Network Access**, permite `0.0.0.0/0`: las funciones de Vercel no tienen IP fija.
2. En Vercel, **Add New → Project**, importa este repositorio y pon **Root Directory** en `server`. No hace falta tocar el framework ni los comandos de build.
3. En **Settings → Environment Variables**, añade:

   | Variable | Valor |
   |---|---|
   | `MONGODB_URI` | La cadena de conexión de Atlas (`mongodb+srv://usuario:contraseña@…`) |
   | `MONGODB_DB` | Opcional. Nombre de la base de datos (por defecto `pasalo`) |

4. Despliega y comprueba `https://<tu-proyecto>.vercel.app/api/health`. Tiene que contestar `{"ok":true}`.
5. La app viene apuntando a `https://pasalo-server.vercel.app` (`DEFAULT_SERVER` en `app/src-tauri/src/lib.rs`). Para usar otro despliegue, cámbialo ahí antes de compilar o ponlo en ⚙ **Ajustes → Server de conexión**.

Los índices (incluidos los TTL que borran lo abandonado) se crean solos la primera vez.

## Cómo funciona

Todo es `POST /api/<acción>` con un JSON que lleva `id` (el identificador del equipo) y `token` (aleatorio, de cada sesión):

| Acción | Qué hace |
|---|---|
| `join` | Entra con `name`, `platform` y `code` (el código de iroh, que solo se revela al aceptar). |
| `sync` | Espera hasta 20 s a que cambie algo y devuelve la lista de conectados, las solicitudes recibidas y las respuestas a las propias. Si no cambió nada, solo devuelve la versión `v`. |
| `request` | Pide conectarse con `to`. |
| `cancel` | Retira una solicitud propia. |
| `answer` | Acepta (`accept: true`) o rechaza una solicitud recibida. Al aceptar devuelve la pareja con su código y saca a los dos del server: las demás solicitudes de los dos se cancelan y ya no aparecen para nadie. |
| `leave` | Sale del server. |

Gasto en el móvil: mientras se está conectado y sin hacer nada, una petición pequeña cada 20 s. Sin pulsar **Conectarse**, la app no habla con el server.

Un equipo que deja de sincronizar desaparece de la lista a los 45 s. Las solicitudes sin contestar caducan a los 5 minutos.

## Probar en local

```sh
npm install
npm test            # pruebas contra un MongoDB real en memoria
npm run dev         # server en http://localhost:3000 (MongoDB en memoria si no hay MONGODB_URI)
```

Para probar con un móvil por USB: `adb reverse tcp:3000 tcp:3000` y en Ajustes `http://localhost:3000`. El CLI también puede entrar: `pasalo listen --server http://localhost:3000` (añade `--connect <nombre>` para pedir conexión con alguien, o `--yes` para aceptar todo).
