const crypto = require("node:crypto");

const DEFAULT_TOKEN_BYTES = 32;
const DEFAULT_COOKIE_NAME = "pi_mt_dashboard_token";

function generateDashboardToken(options = {}) {
  const bytes = Number.isFinite(options.bytes) && options.bytes > 0 ? Math.floor(options.bytes) : DEFAULT_TOKEN_BYTES;
  return crypto.randomBytes(bytes).toString("base64url");
}

function redactToken(token, options = {}) {
  const text = String(token || "");
  if (!text) return "<none>";
  const prefix = options.prefix ?? 6;
  const suffix = options.suffix ?? 4;
  if (text.length <= prefix + suffix + 3) return "<redacted>";
  return `${text.slice(0, prefix)}…${text.slice(-suffix)}`;
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  if (!left.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseCookieHeader(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    const value = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function bearerTokenFromHeader(header) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || "").trim());
  return match ? match[1].trim() : undefined;
}

function tokenFromRequest(req, url, options = {}) {
  const cookieName = options.cookieName || DEFAULT_COOKIE_NAME;
  const queryToken = url?.searchParams?.get("token") || undefined;
  const bearer = bearerTokenFromHeader(req?.headers?.authorization);
  const cookies = parseCookieHeader(req?.headers?.cookie);
  return bearer || queryToken || cookies[cookieName] || undefined;
}

function createDashboardAuth(options = {}) {
  const token = options.token || generateDashboardToken(options);
  const cookieName = options.cookieName || DEFAULT_COOKIE_NAME;

  function validate(candidate) {
    return timingSafeEqualString(candidate, token);
  }

  function authenticateRequest(req, url) {
    return validate(tokenFromRequest(req, url, { cookieName }));
  }

  function cookieHeader(value = token) {
    return `${cookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict`;
  }

  function clearCookieHeader() {
    return `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  return {
    token,
    cookieName,
    validate,
    authenticateRequest,
    cookieHeader,
    clearCookieHeader,
    redact: () => redactToken(token),
  };
}

module.exports = {
  DEFAULT_COOKIE_NAME,
  DEFAULT_TOKEN_BYTES,
  bearerTokenFromHeader,
  createDashboardAuth,
  generateDashboardToken,
  parseCookieHeader,
  redactToken,
  timingSafeEqualString,
  tokenFromRequest,
};
