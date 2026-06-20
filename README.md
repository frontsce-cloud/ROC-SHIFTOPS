// ── Auth: PBKDF2-SHA256 PIN hashing, session cookies, brute-force lockout ──
//
// 5,000 PBKDF2-HMAC-SHA256 iterations — chosen to run on the Workers FREE
// plan, which caps CPU time at 10ms/request (hashing + D1 query + routing +
// everything else, combined). Benchmarked on workerd (the real Workers
// engine): 5,000 iterations ≈ 2.5ms, leaving headroom for the rest of the
// request. 210,000 iterations (the original target, OWASP-era strength)
// measured ≈ 95ms — 9x over budget — and would require the $5/mo Paid plan.
//
// Real-world tradeoff: this is still salted + hashed (a huge improvement
// over the plaintext PINs in the original file), and the 5-attempt lockout
// below fully blocks anyone guessing PINs at the login screen regardless of
// iteration count. What's weaker at 5,000 iterations specifically is
// resistance to OFFLINE brute-force if the D1 database itself is ever read
// directly by an attacker (e.g. a leaked Cloudflare API token) — a 6-digit
// PIN's keyspace (1,000,000 values) becomes crackable in minutes rather than
// hours in that scenario. For a 16-person internal team this is an
// acceptable tradeoff for staying on Free; bump this back to 210000 (and
// move to the Paid plan) if that calculus ever changes.
const PBKDF2_ITERATIONS = 5000;
const SESSION_DAYS = 14;
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MINUTES = 15;

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

export async function hashPin(pin, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(pin), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt) };
}

export async function verifyPin(pin, saltHex, expectedHashHex) {
  const { hash } = await hashPin(pin, saltHex);
  if (hash.length !== expectedHashHex.length) return false;
  // Constant-time-ish comparison to avoid trivial timing side-channels.
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ expectedHashHex.charCodeAt(i);
  return diff === 0;
}

export function newToken() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function sessionCookie(token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
export function clearCookie() {
  return `session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

export async function createSession(db, staffId) {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare('INSERT INTO sessions (token, staff_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, staffId, expires).run();
  return token;
}

export async function getSessionStaff(db, request) {
  const token = getCookie(request, 'session');
  if (!token) return null;
  const row = await db.prepare(
    `SELECT staff.* FROM sessions
     JOIN staff ON staff.id = sessions.staff_id
     WHERE sessions.token = ? AND sessions.expires_at > datetime('now')`
  ).bind(token).first();
  return row || null;
}

export async function destroySession(db, request) {
  const token = getCookie(request, 'session');
  if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}
