import { httpError } from '../lib/http-error.js';

// Limitador de ventana deslizante en memoria (por proceso). Sin dependencias externas.
export function createRateLimiter({ windowMs, max, keyFn = (request) => request.ip }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, times] of hits) {
      const recent = times.filter((time) => time > cutoff);
      if (recent.length) hits.set(key, recent);
      else hits.delete(key);
    }
  }, Math.max(windowMs, 30000));
  timer.unref();

  return (request, _response, next) => {
    const key = String(keyFn(request) ?? 'anon');
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((time) => time > now - windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      next(httpError(429, 'Demasiadas solicitudes. Espera un momento e intenta de nuevo.'));
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}
