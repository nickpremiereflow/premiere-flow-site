export class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}

export function requireSameOrigin(request, origin) {
  if (request.headers.get('origin') !== origin) throw new HttpError(403, 'This request could not be verified.', 'INVALID_ORIGIN');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) throw new HttpError(403, 'This request could not be verified.', 'INVALID_ORIGIN');
}

export async function readJson(request, maxBytes = 32_768) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'Use a JSON request.');
  if (Number(request.headers.get('content-length')) > maxBytes) throw new HttpError(413, 'The request is too large.');
  let size = 0;
  const chunks = [];
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'A request body is required.');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new HttpError(413, 'The request is too large.'); }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid object');
    return body;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'The request is invalid.');
  }
}

export function shortText(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new HttpError(400, `${label} is invalid.`);
  return value.trim();
}

export function onlyKeys(body, allowed) {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(400, 'The request contains unsupported fields.');
}

export function safeError(error) {
  if (error instanceof HttpError) return json({ success: false, error: error.message, code: error.code }, error.status);
  return json({ success: false, error: 'The service is temporarily unavailable. Please try again.', code: 'SERVICE_UNAVAILABLE' }, 503);
}
