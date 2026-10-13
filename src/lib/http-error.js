export function httpError(statusCode, message, expose = true, code = undefined) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = expose;
  if (code) error.publicCode = code;
  return error;
}

export function assert(condition, statusCode, message) {
  if (!condition) {
    throw httpError(statusCode, message);
  }
}
