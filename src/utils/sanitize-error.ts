/**
 * Sanitize upstream API errors before sending to the client.
 * LaoZhang is a Chinese proxy and sometimes returns Chinese error messages —
 * we never want those reaching end users.
 */

const NON_ASCII_RE = /[^\x00-\x7F]/;

const STATUS_MESSAGES: Record<number, string> = {
  400: 'The request was invalid. Please try again with different parameters.',
  401: 'Authentication failed. Please try again later.',
  402: 'Insufficient credits or payment required.',
  403: 'Access denied. Please try again later.',
  404: 'The requested resource was not found.',
  408: 'The request timed out. Please try again.',
  413: 'The image is too large. Please use a smaller file.',
  429: 'Too many requests — please wait a moment and try again.',
  500: 'Our AI provider is temporarily unavailable. Please try again in a few minutes.',
  502: 'Our AI provider is temporarily unavailable. Please try again in a few minutes.',
  503: 'Our AI provider is temporarily unavailable. Please try again shortly.',
  504: 'The request timed out. Please try again.',
};

const DEFAULT_MESSAGE = 'Something went wrong. Please try again later.';

/**
 * Returns a clean, English-only error message safe for end users.
 * The original raw message is logged server-side for debugging.
 */
export function sanitizeError(raw: string | undefined | null, statusCode?: number, logTag?: string): string {
  const rawStr = (raw ?? '').trim();

  if (logTag && rawStr) {
    console.error(`[${logTag}] Upstream error (raw): ${rawStr}`);
  }

  if (!rawStr || NON_ASCII_RE.test(rawStr)) {
    return (statusCode && STATUS_MESSAGES[statusCode]) || DEFAULT_MESSAGE;
  }

  if (rawStr.toLowerCase().includes('laozhang')) {
    return (statusCode && STATUS_MESSAGES[statusCode]) || DEFAULT_MESSAGE;
  }

  if (rawStr.length > 200) {
    return (statusCode && STATUS_MESSAGES[statusCode]) || DEFAULT_MESSAGE;
  }

  return rawStr;
}

export function sanitizeErrorFromStatus(statusCode: number): string {
  return STATUS_MESSAGES[statusCode] || DEFAULT_MESSAGE;
}
