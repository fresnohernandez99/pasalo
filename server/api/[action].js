// API sin versión: la de las apps anteriores a /api/v1. No cambia; lo nuevo
// va en api/v1. POST /api/<acción> con un JSON (ver lib/lobby.js y, para las
// estadísticas de llamadas, lib/stats.js); GET /api/health y GET /api/stats.

import { apiHandler } from '../lib/http.js';

export default apiHandler(0);
