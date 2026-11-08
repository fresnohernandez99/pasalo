// API v1: lo mismo que la API sin versión más la lista de conectados por
// páginas (`users`). POST /api/v1/<acción>; GET /api/v1/health y /api/v1/stats.

import { apiHandler } from '../../lib/http.js';

export default apiHandler(1);
