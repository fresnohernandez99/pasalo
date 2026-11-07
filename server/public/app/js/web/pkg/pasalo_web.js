/**
 * Una conexión de iroh con otro equipo.
 */
export class Conn {
    static __wrap(ptr) {
        const obj = Object.create(Conn.prototype);
        obj.__wbg_ptr = ptr;
        ConnFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ConnFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_conn_free(ptr, 0);
    }
    /**
     * `[send, recv]`, o `null` cuando se cierra la conexión.
     * @returns {Promise<any>}
     */
    acceptBi() {
        const ret = wasm.conn_acceptBi(this.__wbg_ptr);
        return ret;
    }
    /**
     * `Recv`, o `null` cuando se cierra la conexión.
     * @returns {Promise<any>}
     */
    acceptUni() {
        const ret = wasm.conn_acceptUni(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string}
     */
    get alpn() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.conn_alpn(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} code
     * @param {string} reason
     */
    close(code, reason) {
        const val2 = +code;
        const ptr0 = passStringToWasm0(reason, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.conn_close(this.__wbg_ptr, val2, ptr0, len0);
    }
    /**
     * @returns {boolean}
     */
    get closed() {
        const ret = wasm.conn_closed(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Identifica la conexión (dos `Conn` con el mismo id son la misma).
     * @returns {number}
     */
    get id() {
        const ret = wasm.conn_id(this.__wbg_ptr);
        return ret;
    }
    /**
     * Si la abrió el otro lado.
     * @returns {boolean}
     */
    get incoming() {
        const ret = wasm.conn_incoming(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * `[send, recv]`.
     * @param {number} wait
     * @returns {Promise<any>}
     */
    openBi(wait) {
        const ret = wasm.conn_openBi(this.__wbg_ptr, wait);
        return ret;
    }
    /**
     * @param {number} wait
     * @returns {Promise<any>}
     */
    openUni(wait) {
        const ret = wasm.conn_openUni(this.__wbg_ptr, wait);
        return ret;
    }
    /**
     * El siguiente datagrama, o `null` cuando se cierra la conexión.
     * @returns {Promise<any>}
     */
    readDatagram() {
        const ret = wasm.conn_readDatagram(this.__wbg_ptr);
        return ret;
    }
    /**
     * Código del otro equipo.
     * @returns {string}
     */
    get remote() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.conn_remote(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Envía un datagrama (no fiable). `false` si no se pudo.
     * @param {Uint8Array | number[]} data
     * @returns {boolean}
     */
    sendDatagram(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.conn_sendDatagram(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Termina cuando se cierra, con el motivo.
     * @returns {Promise<any>}
     */
    waitClosed() {
        const ret = wasm.conn_waitClosed(this.__wbg_ptr);
        return ret;
    }
    /**
     * Bytes que han salido y entrado, con 28 de cabeceras IPv4 y UDP por
     * datagrama: `[enviados, recibidos]` (como `voice_stats` en las apps).
     * @returns {Float64Array}
     */
    wireBytes() {
        const ret = wasm.conn_wireBytes(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
}
if (Symbol.dispose) Conn.prototype[Symbol.dispose] = Conn.prototype.free;

/**
 * BLAKE3 incremental, para verificar los archivos como las apps.
 */
export class Hasher {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        HasherFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_hasher_free(ptr, 0);
    }
    /**
     * En hex. No consume el estado.
     * @returns {string}
     */
    hex() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.hasher_hex(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    constructor() {
        const ret = wasm.hasher_new();
        this.__wbg_ptr = ret;
        HasherFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Uint8Array | number[]} data
     */
    update(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.hasher_update(this.__wbg_ptr, ptr0, len0);
    }
}
if (Symbol.dispose) Hasher.prototype[Symbol.dispose] = Hasher.prototype.free;

export class IntoUnderlyingByteSource {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingByteSourceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingbytesource_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get autoAllocateChunkSize() {
        const ret = wasm.intounderlyingbytesource_autoAllocateChunkSize(this.__wbg_ptr);
        return ret >>> 0;
    }
    cancel() {
        const ptr = this.__destroy_into_raw();
        wasm.intounderlyingbytesource_cancel(ptr);
    }
    /**
     * @param {ReadableByteStreamController} controller
     * @returns {Promise<any>}
     */
    pull(controller) {
        const ret = wasm.intounderlyingbytesource_pull(this.__wbg_ptr, controller);
        return ret;
    }
    /**
     * @param {ReadableByteStreamController} controller
     */
    start(controller) {
        wasm.intounderlyingbytesource_start(this.__wbg_ptr, controller);
    }
    /**
     * @returns {ReadableStreamType}
     */
    get type() {
        const ret = wasm.intounderlyingbytesource_type(this.__wbg_ptr);
        return __wbindgen_enum_ReadableStreamType[ret];
    }
}
if (Symbol.dispose) IntoUnderlyingByteSource.prototype[Symbol.dispose] = IntoUnderlyingByteSource.prototype.free;

export class IntoUnderlyingSink {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingSinkFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingsink_free(ptr, 0);
    }
    /**
     * @param {any} reason
     * @returns {Promise<any>}
     */
    abort(reason) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.intounderlyingsink_abort(ptr, reason);
        return ret;
    }
    /**
     * @returns {Promise<any>}
     */
    close() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.intounderlyingsink_close(ptr);
        return ret;
    }
    /**
     * @param {any} chunk
     * @returns {Promise<any>}
     */
    write(chunk) {
        const ret = wasm.intounderlyingsink_write(this.__wbg_ptr, chunk);
        return ret;
    }
}
if (Symbol.dispose) IntoUnderlyingSink.prototype[Symbol.dispose] = IntoUnderlyingSink.prototype.free;

export class IntoUnderlyingSource {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingSourceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingsource_free(ptr, 0);
    }
    cancel() {
        const ptr = this.__destroy_into_raw();
        wasm.intounderlyingsource_cancel(ptr);
    }
    /**
     * @param {ReadableStreamDefaultController} controller
     * @returns {Promise<any>}
     */
    pull(controller) {
        const ret = wasm.intounderlyingsource_pull(this.__wbg_ptr, controller);
        return ret;
    }
}
if (Symbol.dispose) IntoUnderlyingSource.prototype[Symbol.dispose] = IntoUnderlyingSource.prototype.free;

/**
 * Punto de conexión de este navegador.
 */
export class Node {
    static __wrap(ptr) {
        const obj = Object.create(Node.prototype);
        obj.__wbg_ptr = ptr;
        NodeFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        NodeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_node_free(ptr, 0);
    }
    /**
     * La siguiente conexión entrante ya establecida, o `null` si se cerró el punto de conexión.
     * @returns {Promise<any>}
     */
    accept() {
        const ret = wasm.node_accept(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Promise<any>}
     */
    close() {
        const ret = wasm.node_close(this.__wbg_ptr);
        return ret;
    }
    /**
     * Código de este equipo (su clave pública, en hex).
     * @returns {string}
     */
    get code() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.node_code(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Conecta con el equipo `code` por el protocolo `alpn` (`pasalo/1` o `pasalo/talk/1`).
     * @param {string} code
     * @param {string} alpn
     * @param {number} wait
     * @returns {Promise<any>}
     */
    connect(code, alpn, wait) {
        const val3 = +wait;
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(code, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(alpn, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.node_connect(this.__wbg_ptr, ptr0, len0, ptr1, len1, val3);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    get internet() {
        const ret = wasm.node_internet(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Termina cuando hay relay (o con `false` si no llega en `wait` ms).
     * @param {number} wait
     * @returns {Promise<any>}
     */
    online(wait) {
        const ret = wasm.node_online(this.__wbg_ptr, wait);
        return ret;
    }
    /**
     * La clave secreta en hex, para guardarla y conservar el código.
     * @returns {string}
     */
    get secret() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.node_secret(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Añade (o quita) los relays de n0 y la publicación del código por pkarr.
     * @param {boolean} on
     * @returns {Promise<any>}
     */
    setInternet(on) {
        const ret = wasm.node_setInternet(this.__wbg_ptr, on);
        return ret;
    }
    /**
     * Arranca con la clave guardada (hex) o con una nueva. Como en las
     * apps, empieza sin relays: nada sale a internet hasta `setInternet(true)`.
     * @param {string | null} [secret]
     * @returns {Promise<any>}
     */
    static start(secret) {
        var ptr0 = isLikeNone(secret) ? 0 : passStringToWasm0(secret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len0 = WASM_VECTOR_LEN;
        const ret = wasm.node_start(ptr0, len0);
        return ret;
    }
}
if (Symbol.dispose) Node.prototype[Symbol.dispose] = Node.prototype.free;

/**
 * Lado de lectura de un stream.
 */
export class Recv {
    static __wrap(ptr) {
        const obj = Object.create(Recv.prototype);
        obj.__wbg_ptr = ptr;
        RecvFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RecvFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_recv_free(ptr, 0);
    }
    /**
     * Todo hasta el final del stream (como mucho `max` bytes).
     * @param {number} max
     * @param {number} wait
     * @returns {Promise<any>}
     */
    readToEnd(max, wait) {
        const ret = wasm.recv_readToEnd(this.__wbg_ptr, max, wait);
        return ret;
    }
    /**
     * Lo que haya llegado (hasta `max` bytes), o `null` al final del stream.
     * @param {number} max
     * @param {number} wait
     * @returns {Promise<any>}
     */
    read(max, wait) {
        const ret = wasm.recv_read(this.__wbg_ptr, max, wait);
        return ret;
    }
    stop() {
        wasm.recv_stop(this.__wbg_ptr);
    }
}
if (Symbol.dispose) Recv.prototype[Symbol.dispose] = Recv.prototype.free;

/**
 * Lado de envío de un stream.
 */
export class Send {
    static __wrap(ptr) {
        const obj = Object.create(Send.prototype);
        obj.__wbg_ptr = ptr;
        SendFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SendFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_send_free(ptr, 0);
    }
    /**
     * Ya no se escribe más.
     */
    finish() {
        wasm.send_finish(this.__wbg_ptr);
    }
    reset() {
        wasm.send_reset(this.__wbg_ptr);
    }
    /**
     * @param {number} priority
     */
    setPriority(priority) {
        wasm.send_setPriority(this.__wbg_ptr, priority);
    }
    /**
     * Termina cuando el otro lado lo ha recibido todo (tras `finish`).
     * @param {number} wait
     * @returns {Promise<any>}
     */
    stopped(wait) {
        const ret = wasm.send_stopped(this.__wbg_ptr, wait);
        return ret;
    }
    /**
     * Escribe todo `data` (esperando a que el otro lado haga sitio, hasta `wait` ms).
     * @param {Uint8Array | number[]} data
     * @param {number} wait
     * @returns {Promise<any>}
     */
    write(data, wait) {
        const val2 = +wait;
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.send_write(this.__wbg_ptr, ptr0, len0, val2);
        return ret;
    }
}
if (Symbol.dispose) Send.prototype[Symbol.dispose] = Send.prototype.free;

/**
 * Voz de una llamada: micrófono → paquetes y paquetes → altavoz, con el
 * mismo formato que las apps (ver `pasalo-call`).
 */
export class Voice {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        VoiceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_voice_free(ptr, 0);
    }
    /**
     * `[perdidos, recuperados]`.
     * @returns {Float64Array}
     */
    losses() {
        const ret = wasm.voice_losses(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * `rate` es el del AudioContext (entrada y salida).
     * @param {string} mode_name
     * @param {number} rate
     */
    constructor(mode_name, rate) {
        const val2 = +rate;
        const ptr0 = passStringToWasm0(mode_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.voice_new(ptr0, len0, val2);
        this.__wbg_ptr = ret;
        VoiceFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * `n` muestras para el altavoz.
     * @param {number} n
     * @returns {Float32Array}
     */
    play(n) {
        const ret = wasm.voice_play(this.__wbg_ptr, n);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Un paquete que llegó del otro lado.
     * @param {Uint8Array | number[]} packet
     */
    receive(packet) {
        const ptr0 = passArray8ToWasm0(packet, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.voice_receive(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Muestras del micrófono; devuelve los paquetes que haya que enviar.
     * @param {Float32Array | number[]} samples
     * @returns {Array<any>}
     */
    record(samples) {
        const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.voice_record(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * @param {string} mode_name
     */
    setMode(mode_name) {
        const ptr0 = passStringToWasm0(mode_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.voice_setMode(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {boolean} muted
     */
    setMuted(muted) {
        wasm.voice_setMuted(this.__wbg_ptr, muted);
    }
}
if (Symbol.dispose) Voice.prototype[Symbol.dispose] = Voice.prototype.free;

/**
 * Código de un equipo en hex minúsculas (como lo guardan las apps), o
 * `undefined` si no es válido. Acepta hex o base32 y quita los espacios.
 * @param {string} code
 * @returns {string | undefined}
 */
export function parse_code(code) {
    const ptr0 = passStringToWasm0(code, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse_code(ptr0, len0);
    let v2;
    if (ret[0] !== 0) {
        v2 = getStringFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v2;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_boolean_get_4f1baf9a00be3c74: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_f249a2a76caa9a55: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_is_function_741ff2bb612836f5: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_8b968c3ab8e96595: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_fc456fee5d3317de: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_be5b34249ff1fc15: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_string_get_7ce8eee7fd327545: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_4c88d8bf264fd984: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_09736879a3f67559: function(arg0) {
            arg0._wbg_cb_unref();
        },
        __wbg_abort_d3b62653236ec492: function(arg0, arg1) {
            arg0.abort(arg1);
        },
        __wbg_abort_f8d1589eb0c65ee2: function(arg0) {
            arg0.abort();
        },
        __wbg_addEventListener_d53349875ac0f21d: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            arg0.addEventListener(getStringFromWasm0(arg1, arg2), arg3);
        }, arguments); },
        __wbg_append_ba9a4dc30a0323fd: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            arg0.append(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
        }, arguments); },
        __wbg_arrayBuffer_2c99a9ba14ba536c: function() { return handleError(function (arg0) {
            const ret = arg0.arrayBuffer();
            return ret;
        }, arguments); },
        __wbg_body_0da01a9a056907d8: function(arg0) {
            const ret = arg0.body;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_buffer_aca05a93c046db1a: function(arg0) {
            const ret = arg0.buffer;
            return ret;
        },
        __wbg_byobRequest_18280c78e462544c: function(arg0) {
            const ret = arg0.byobRequest;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_byteLength_c5f3c188d5252e5b: function(arg0) {
            const ret = arg0.byteLength;
            return ret;
        },
        __wbg_byteOffset_63cdc7b38f33a45e: function(arg0) {
            const ret = arg0.byteOffset;
            return ret;
        },
        __wbg_call_a410eb4b59ed5965: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_cancel_b195250778e9d8e7: function(arg0) {
            const ret = arg0.cancel();
            return ret;
        },
        __wbg_catch_fd4c7ea14fde9d83: function(arg0, arg1) {
            const ret = arg0.catch(arg1);
            return ret;
        },
        __wbg_clearTimeout_1daad5c6ee4fcd3b: function(arg0) {
            const ret = clearTimeout(arg0);
            return ret;
        },
        __wbg_clearTimeout_9907b21a47eea51c: function() { return handleError(function (arg0, arg1) {
            arg0.clearTimeout(arg1);
        }, arguments); },
        __wbg_close_294d3f727cb7a844: function() { return handleError(function (arg0) {
            arg0.close();
        }, arguments); },
        __wbg_close_5ee9c5fe4e8754a4: function() { return handleError(function (arg0) {
            arg0.close();
        }, arguments); },
        __wbg_close_bf94aa7e38b9a94b: function() { return handleError(function (arg0) {
            arg0.close();
        }, arguments); },
        __wbg_code_3e6881d821eab2c4: function(arg0) {
            const ret = arg0.code;
            return ret;
        },
        __wbg_code_5e0bc002c38697e5: function(arg0) {
            const ret = arg0.code;
            return ret;
        },
        __wbg_conn_new: function(arg0) {
            const ret = Conn.__wrap(arg0);
            return ret;
        },
        __wbg_crypto_23f565a907d30078: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_data_c7e5e8500f1bca2f: function(arg0) {
            const ret = arg0.data;
            return ret;
        },
        __wbg_debug_29e5044b8c3730bb: function(arg0) {
            console.debug(arg0);
        },
        __wbg_done_57e08d0be6e30c02: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_enqueue_c11626eae1c54509: function() { return handleError(function (arg0, arg1) {
            arg0.enqueue(arg1);
        }, arguments); },
        __wbg_entries_fb0b3ba27a6e0bf7: function(arg0) {
            const ret = arg0.entries();
            return ret;
        },
        __wbg_fetch_41d29a2b2428e0c7: function(arg0, arg1) {
            const ret = arg0.fetch(arg1);
            return ret;
        },
        __wbg_fetch_7a37768ab67c5bd8: function(arg0) {
            const ret = fetch(arg0);
            return ret;
        },
        __wbg_getRandomValues_8b6f1f663e6f188d: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbg_getRandomValues_d2908e0b99612b91: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_getReader_6912875434814e8c: function() { return handleError(function (arg0) {
            const ret = arg0.getReader();
            return ret;
        }, arguments); },
        __wbg_get_2080c49015e35254: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_d7176cfb76d71114: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_done_3bf2b4a34e149301: function(arg0) {
            const ret = arg0.done;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg_get_value_9454480da7066d61: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_has_2c4d5cf25ec8c1cf: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.has(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_headers_5fc0106c076eb731: function(arg0) {
            const ret = arg0.headers;
            return ret;
        },
        __wbg_instanceof_ArrayBuffer_12cdaa4161423e6b: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Blob_56431c8f5387c12d: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Blob;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Response_5b0b4f7f1daeae51: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Response;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_bcf1376d0d732d08: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_length_186163212ffe79c3: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_message_fc58bc095885b5e5: function(arg0, arg1) {
            const ret = arg1.message;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        },
        __wbg_msCrypto_d5f06fad6bf1409b: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_13de428334042d26: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_277c27c26f94cbc2: function() { return handleError(function () {
            const ret = new Headers();
            return ret;
        }, arguments); },
        __wbg_new_37eb45aaf5eeb820: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_5f28518387ad0e34: function() { return handleError(function () {
            const ret = new AbortController();
            return ret;
        }, arguments); },
        __wbg_new_787b9fb330d55d78: function(arg0, arg1) {
            const ret = new Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_cd4348290afae586: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_d72daa1c90ded389: function() { return handleError(function (arg0, arg1) {
            const ret = new WebSocket(getStringFromWasm0(arg0, arg1));
            return ret;
        }, arguments); },
        __wbg_new_from_slice_b8daf545a41c6aa0: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_typed_e09da9dae6ee5935: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke___js_sys_2e37a2c594f4b96f___Function_fn_wasm_bindgen_d252b2ab9df6e287___JsValue_____wasm_bindgen_d252b2ab9df6e287___sys__Undefined___js_sys_2e37a2c594f4b96f___Function_fn_wasm_bindgen_d252b2ab9df6e287___JsValue_____wasm_bindgen_d252b2ab9df6e287___sys__Undefined_______true_(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_with_byte_offset_and_length_3cd32055a417f095: function(arg0, arg1, arg2) {
            const ret = new Uint8Array(arg0, arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_new_with_length_01b143a7e5dd5a3e: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_new_with_str_and_init_d9f6b5611184e16b: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = new Request(getStringFromWasm0(arg0, arg1), arg2);
            return ret;
        }, arguments); },
        __wbg_new_with_str_sequence_75b26d88172889d0: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = new WebSocket(getStringFromWasm0(arg0, arg1), arg2);
            return ret;
        }, arguments); },
        __wbg_next_af5ac6a08bb0a717: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_node_86166ff8ce1f2002: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_node_new: function(arg0) {
            const ret = Node.__wrap(arg0);
            return ret;
        },
        __wbg_now_463ac581d2fc7ea3: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_now_e7c6795a7f81e10f: function(arg0) {
            const ret = arg0.now();
            return ret;
        },
        __wbg_performance_7e4e4494fdc9d07a: function(arg0) {
            const ret = arg0.performance;
            return ret;
        },
        __wbg_process_91f425a63f58e399: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_protocol_2ecd96d73c042808: function(arg0, arg1) {
            const ret = arg1.protocol;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        },
        __wbg_prototypesetcall_13162965d1fe7aa3: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_c9f4893fc209f768: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_queueMicrotask_1e8503a8a690f0a3: function(arg0) {
            const ret = arg0.queueMicrotask;
            return ret;
        },
        __wbg_queueMicrotask_4a1a4d8dd332373b: function(arg0) {
            queueMicrotask(arg0);
        },
        __wbg_randomFillSync_34b023059e3363de: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_read_e3bea75dace70752: function(arg0) {
            const ret = arg0.read();
            return ret;
        },
        __wbg_readyState_039bc047141a5f6d: function(arg0) {
            const ret = arg0.readyState;
            return ret;
        },
        __wbg_reason_34b16516ab3f72d4: function(arg0, arg1) {
            const ret = arg1.reason;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        },
        __wbg_recv_new: function(arg0) {
            const ret = Recv.__wrap(arg0);
            return ret;
        },
        __wbg_releaseLock_eddf1401c763f0b9: function(arg0) {
            arg0.releaseLock();
        },
        __wbg_removeEventListener_bb4dca2a6e9daa4f: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            arg0.removeEventListener(getStringFromWasm0(arg1, arg2), arg3);
        }, arguments); },
        __wbg_require_9a7d8cc2e1d275c0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_resolve_dbf78ab4942478b0: function(arg0) {
            const ret = Promise.resolve(arg0);
            return ret;
        },
        __wbg_respond_d97c023ee981d1f5: function() { return handleError(function (arg0, arg1) {
            arg0.respond(arg1 >>> 0);
        }, arguments); },
        __wbg_send_d83d0891cf698779: function() { return handleError(function (arg0, arg1, arg2) {
            arg0.send(getArrayU8FromWasm0(arg1, arg2));
        }, arguments); },
        __wbg_send_new: function(arg0) {
            const ret = Send.__wrap(arg0);
            return ret;
        },
        __wbg_setTimeout_4557ad52e57b0696: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.setTimeout(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_setTimeout_b4a9096784635514: function(arg0, arg1) {
            const ret = setTimeout(arg0, arg1);
            return ret;
        },
        __wbg_set_binaryType_d5b4dafd0f127fb2: function(arg0, arg1) {
            arg0.binaryType = __wbindgen_enum_BinaryType[arg1];
        },
        __wbg_set_body_877d5251e78ca815: function(arg0, arg1) {
            arg0.body = arg1;
        },
        __wbg_set_cache_7a23201e29cbd632: function(arg0, arg1) {
            arg0.cache = __wbindgen_enum_RequestCache[arg1];
        },
        __wbg_set_credentials_bb5277b4006149d4: function(arg0, arg1) {
            arg0.credentials = __wbindgen_enum_RequestCredentials[arg1];
        },
        __wbg_set_feb3714f475485ba: function(arg0, arg1, arg2) {
            arg0.set(getArrayU8FromWasm0(arg1, arg2));
        },
        __wbg_set_handle_event_11da5526e4fc85b0: function(arg0, arg1) {
            arg0.handleEvent = arg1;
        },
        __wbg_set_headers_6d75a7df4eb22716: function(arg0, arg1) {
            arg0.headers = arg1;
        },
        __wbg_set_method_639e69af35614d36: function(arg0, arg1, arg2) {
            arg0.method = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_mode_07e051ad8b4e2126: function(arg0, arg1) {
            arg0.mode = __wbindgen_enum_RequestMode[arg1];
        },
        __wbg_set_onclose_078935cf8d0fb024: function(arg0, arg1) {
            arg0.onclose = arg1;
        },
        __wbg_set_onerror_f7f089f7f059501c: function(arg0, arg1) {
            arg0.onerror = arg1;
        },
        __wbg_set_onmessage_26abc49cfa5f9ffc: function(arg0, arg1) {
            arg0.onmessage = arg1;
        },
        __wbg_set_onopen_757be120cc7b1ea6: function(arg0, arg1) {
            arg0.onopen = arg1;
        },
        __wbg_set_referrer_413a47ffe5e2e157: function(arg0, arg1, arg2) {
            arg0.referrer = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_referrer_policy_f3e837a21403cf06: function(arg0, arg1) {
            arg0.referrerPolicy = __wbindgen_enum_ReferrerPolicy[arg1];
        },
        __wbg_set_signal_0b2eee78907e5ba7: function(arg0, arg1) {
            arg0.signal = arg1;
        },
        __wbg_signal_fac908876f45725d: function(arg0) {
            const ret = arg0.signal;
            return ret;
        },
        __wbg_static_accessor_GLOBAL_THIS_003ee833af9699fc: function() {
            const ret = typeof globalThis === 'undefined' ? undefined : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_e4293fb22cbe77da: function() {
            const ret = typeof global === 'undefined' ? undefined : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_53bb20457401453d: function() {
            const ret = typeof self === 'undefined' ? undefined : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_b5e0810bfecb7feb: function() {
            const ret = typeof window === 'undefined' ? undefined : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_status_cb85b6c8d1769fa1: function(arg0) {
            const ret = arg0.status;
            return ret;
        },
        __wbg_subarray_58f388a9247ac0bb: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_then_656f253a5dd7d8ea: function(arg0, arg1, arg2) {
            const ret = arg0.then(arg1, arg2);
            return ret;
        },
        __wbg_then_e3f7f2d365708be8: function(arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        },
        __wbg_url_9fadea28ec624f1d: function(arg0, arg1) {
            const ret = arg1.url;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        },
        __wbg_value_e0f328965e184931: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_versions_6e128a981b0df859: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbg_view_3b708d3bdaf3fc96: function(arg0) {
            const ret = arg0.view;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_wasClean_5318a54e8ede66d8: function(arg0) {
            const ret = arg0.wasClean;
            return ret;
        },
        __wbindgen_generic_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 318, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke___wasm_bindgen_d252b2ab9df6e287___JsValue______true_);
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 378, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke___wasm_bindgen_d252b2ab9df6e287___JsValue__core_37ee0ce0c4cd57d5___result__Result_____wasm_bindgen_d252b2ab9df6e287___JsError___true_);
            return ret;
        },
        __wbindgen_generic_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("CloseEvent")], shim_idx: 318, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke___wasm_bindgen_d252b2ab9df6e287___JsValue______true__55);
            return ret;
        },
        __wbindgen_generic_0000000000000004: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("MessageEvent")], shim_idx: 318, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke___wasm_bindgen_d252b2ab9df6e287___JsValue______true__56);
            return ret;
        },
        __wbindgen_generic_0000000000000005: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 22, ret: Unit, inner_ret: Some(Unit) }, mutable: false }) -> Externref`.
            const ret = makeClosure(arg0, arg1, wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke_______true__1_);
            return ret;
        },
        __wbindgen_generic_0000000000000006: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 310, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke_______true_);
            return ret;
        },
        __wbindgen_generic_0000000000000007: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000008: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            table.set(0, undefined);
            table.set(1024, undefined);
            table.set(1025, null);
            table.set(1026, true);
            table.set(1027, false);
        },
    };
    return {
        __proto__: null,
        "./pasalo_web_bg.js": import0,
    };
}

function wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke_______true__1_(arg0, arg1) {
    wasm.wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke_______true__1_(arg0, arg1);
}

function wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke_______true_(arg0, arg1) {
    wasm.wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke_______true_(arg0, arg1);
}

function wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke___wasm_bindgen_d252b2ab9df6e287___JsValue______true_(arg0, arg1, arg2) {
    wasm.wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke___wasm_bindgen_d252b2ab9df6e287___JsValue______true_(arg0, arg1, arg2);
}

function wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke___wasm_bindgen_d252b2ab9df6e287___JsValue______true__55(arg0, arg1, arg2) {
    wasm.wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke___wasm_bindgen_d252b2ab9df6e287___JsValue______true__55(arg0, arg1, arg2);
}

function wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke___wasm_bindgen_d252b2ab9df6e287___JsValue______true__56(arg0, arg1, arg2) {
    wasm.wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke___wasm_bindgen_d252b2ab9df6e287___JsValue______true__56(arg0, arg1, arg2);
}

function wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke___wasm_bindgen_d252b2ab9df6e287___JsValue__core_37ee0ce0c4cd57d5___result__Result_____wasm_bindgen_d252b2ab9df6e287___JsError___true_(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke___wasm_bindgen_d252b2ab9df6e287___JsValue__core_37ee0ce0c4cd57d5___result__Result_____wasm_bindgen_d252b2ab9df6e287___JsError___true_(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke___js_sys_2e37a2c594f4b96f___Function_fn_wasm_bindgen_d252b2ab9df6e287___JsValue_____wasm_bindgen_d252b2ab9df6e287___sys__Undefined___js_sys_2e37a2c594f4b96f___Function_fn_wasm_bindgen_d252b2ab9df6e287___JsValue_____wasm_bindgen_d252b2ab9df6e287___sys__Undefined_______true_(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen_d252b2ab9df6e287___convert__closures_____invoke___js_sys_2e37a2c594f4b96f___Function_fn_wasm_bindgen_d252b2ab9df6e287___JsValue_____wasm_bindgen_d252b2ab9df6e287___sys__Undefined___js_sys_2e37a2c594f4b96f___Function_fn_wasm_bindgen_d252b2ab9df6e287___JsValue_____wasm_bindgen_d252b2ab9df6e287___sys__Undefined_______true_(arg0, arg1, arg2, arg3);
}


const __wbindgen_enum_BinaryType = ["blob", "arraybuffer"];


const __wbindgen_enum_ReadableStreamType = ["bytes"];


const __wbindgen_enum_ReferrerPolicy = ["", "no-referrer", "no-referrer-when-downgrade", "origin", "origin-when-cross-origin", "unsafe-url", "same-origin", "strict-origin", "strict-origin-when-cross-origin"];


const __wbindgen_enum_RequestCache = ["default", "no-store", "reload", "no-cache", "force-cache", "only-if-cached"];


const __wbindgen_enum_RequestCredentials = ["omit", "same-origin", "include"];


const __wbindgen_enum_RequestMode = ["same-origin", "no-cors", "cors", "navigate"];
const ConnFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_conn_free(ptr, 1));
const HasherFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_hasher_free(ptr, 1));
const IntoUnderlyingByteSourceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingbytesource_free(ptr, 1));
const IntoUnderlyingSinkFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingsink_free(ptr, 1));
const IntoUnderlyingSourceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingsource_free(ptr, 1));
const NodeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_node_free(ptr, 1));
const RecvFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_recv_free(ptr, 1));
const SendFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_send_free(ptr, 1));
const VoiceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_voice_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

function debugString(val) {
    switch (typeof val) {
        // primitive types
        case 'number':
        case 'boolean':
        case 'undefined':
        return `${val}`;
        case 'string':
        return JSON.stringify(val);
        case 'bigint':
        return `${val}n`;
        case 'symbol':
        return val.description !== undefined
            ? `Symbol(${val.description})`
            : 'Symbol';
        case 'function':
        return typeof val.name === 'string' && val.name !== ''
            ? `Function(${val.name})`
            : 'Function';
        case 'object': {
            if (val === null) {
                return 'null';
            }
            // objects
            if (Array.isArray(val)) {
                return '[' + Array.from(val, debugString).join(', ') + ']';
            }
            // errors
            if (val instanceof Error) {
                return `${val.name}: ${val.message}\n${val.stack}`;
            }

            const toStringOutput = toString.call(val);
            // Test for built-in
            const className = /\[object ([^\]]+)\]/.exec(toStringOutput)?.[1];

            // Failed to match the standard '[object ClassName]'
            if (className === undefined) {
                return toStringOutput;
            }
            if (className === 'Object') {
                // we're a user defined class or Object
                // JSON.stringify avoids problems with cycles, and is generally much
                // easier than looping through ownProperties of `val`.
                try {
                    return 'Object(' + JSON.stringify(val) + ')';
                } catch (_) {
                    return 'Object';
                }
            }
            // TODO we could test for more things here, like `Set`s and `Map`s.
            return className;
        }
        // Per MDN: 'This list of values is exhaustive.'
        // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/typeof#description
    }
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        try {
            return f(state.a, state.b, ...args);
        } finally {
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(bytes) {
    numBytesDecoded += bytes.length;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
        cachedTextDecoder.decode();
        numBytesDecoded = bytes.length;
    }
    return cachedTextDecoder.decode(bytes);
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

let __wbg_init_promise;
async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;
    if (__wbg_init_promise === undefined) {
        __wbg_init_promise = __wbg_init_once(module_or_path);
        __wbg_init_promise.catch(() => { __wbg_init_promise = undefined; });
    }
    return __wbg_init_promise;
}

async function __wbg_init_once(module_or_path) {

    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('pasalo_web_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
