// ── D1 query helpers ──────────────────────────────────────────────

const STAFF_COLORS = [
  '#3D7BFF,#6A3DFF', '#0891B2,#059669', '#7C3AED,#BE185D',
  '#D97706,#EF4444', '#059669,#0891B2', '#BE185D,#9333EA',
];

export async function listStaff(db) {
  const { results } = await db.prepare(
    'SELECT id, name, dept, role, color, pin_set FROM staff ORDER BY id'
  ).all();
  return results.map(r => ({
    id: r.id, name: r.name, dept: r.dept, role: r.role, color: r.color,
    pinSet: !!r.pin_set,
  }));
}

// Pre-login roster: same shape but explicitly excludes anything sensitive —
// used to populate the login screen before a session exists.
export async function loginRoster(db) {
  return listStaff(db);
}

export async function getStaffRaw(db, id) {
  return db.prepare('SELECT * FROM staff WHERE id = ?').bind(id).first();
}

export async function createStaff(db, { name, dept, role }) {
  const countRow = await db.prepare('SELECT COUNT(*) AS n FROM staff').first();
  const color = STAFF_COLORS[(countRow?.n || 0) % STAFF_COLORS.length];
  let id;
  // Short, human-recognizable id derived from the name; retried on the rare
  // collision since it's seeded with the current timestamp.
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = (name.substring(0, 2).toUpperCase() + Date.now().toString().slice(-3 + attempt)).slice(0, 4);
    const exists = await db.prepare('SELECT 1 FROM staff WHERE id = ?').bind(candidate).first();
    if (!exists) { id = candidate; break; }
  }
  if (!id) id = crypto.randomUUID().slice(0, 4).toUpperCase();
  await db.prepare('INSERT INTO staff (id, name, dept, role, color, pin_set) VALUES (?, ?, ?, ?, ?, 0)')
    .bind(id, name, dept, role, color).run();
  return id;
}

export async function updateStaff(db, id, { name, dept, role }) {
  await db.prepare('UPDATE staff SET name = ?, dept = ?, role = ? WHERE id = ?')
    .bind(name, dept, role, id).run();
}

export async function setStaffPin(db, id, hash, salt) {
  await db.prepare('UPDATE staff SET pin_hash = ?, pin_salt = ?, pin_set = 1, failed_attempts = 0, locked_until = NULL WHERE id = ?')
    .bind(hash, salt, id).run();
}

export async function resetStaffPin(db, id) {
  await db.prepare('UPDATE staff SET pin_hash = NULL, pin_salt = NULL, pin_set = 0, failed_attempts = 0, locked_until = NULL WHERE id = ?')
    .bind(id).run();
  await db.prepare('DELETE FROM sessions WHERE staff_id = ?').bind(id).run();
}

export async function recordFailedAttempt(db, staff) {
  const attempts = (staff.failed_attempts || 0) + 1;
  if (attempts >= 5) {
    const lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await db.prepare('UPDATE staff SET failed_attempts = 0, locked_until = ? WHERE id = ?')
      .bind(lockedUntil, staff.id).run();
    return { locked: true, lockedUntil };
  }
  await db.prepare('UPDATE staff SET failed_attempts = ? WHERE id = ?').bind(attempts, staff.id).run();
  return { locked: false };
}

export async function clearFailedAttempts(db, id) {
  await db.prepare('UPDATE staff SET failed_attempts = 0, locked_until = NULL WHERE id = ?').bind(id).run();
}

export async function deleteStaffCascade(db, id) {
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE staff_id = ?').bind(id),
    db.prepare('DELETE FROM leave_requests WHERE staff_id = ?').bind(id),
    db.prepare('DELETE FROM swap_requests WHERE from_staff = ? OR to_staff = ?').bind(id, id),
    db.prepare('DELETE FROM schedule_overrides WHERE staff_id = ?').bind(id),
    db.prepare('DELETE FROM staff WHERE id = ?').bind(id),
  ]);
}

export async function updateProfileName(db, id, name) {
  await db.prepare('UPDATE staff SET name = ? WHERE id = ?').bind(name, id).run();
}

// ── Leave ──────────────────────────────────────────────
export async function listLeave(db) {
  const { results } = await db.prepare(
    'SELECT * FROM leave_requests ORDER BY submitted_at DESC, id DESC'
  ).all();
  return results.map(rowToLeave);
}
function rowToLeave(r) {
  return {
    id: r.id, staffId: r.staff_id, name: r.name, dept: r.dept,
    from: r.from_date, to: r.to_date, days: r.days, type: r.type,
    reason: r.reason, status: r.status, submitted: r.submitted_at.split('T')[0],
  };
}

export async function createLeaveRequest(db, { staffId, name, dept, from, to, days, type, reason }) {
  const submitted = new Date().toISOString();
  const res = await db.prepare(
    `INSERT INTO leave_requests (staff_id, name, dept, from_date, to_date, days, type, reason, status, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).bind(staffId, name, dept, from, to, days, type, reason || '', submitted).run();
  return res.meta.last_row_id;
}

export async function getLeaveRequest(db, id) {
  const r = await db.prepare('SELECT * FROM leave_requests WHERE id = ?').bind(id).first();
  return r ? rowToLeave(r) : null;
}

export async function resolveLeaveRequest(db, id, status) {
  await db.prepare('UPDATE leave_requests SET status = ?, resolved_at = ? WHERE id = ?')
    .bind(status, new Date().toISOString(), id).run();
}

// Counts how many people would be on APPROVED leave at once if this range were
// approved too (excluding the request itself). Mirrors the original client rule:
// max 2 people on leave at the same time.
export async function maxLeaveOverlap(db, from, to, excludeId) {
  const { results } = await db.prepare(
    `SELECT from_date, to_date FROM leave_requests WHERE status = 'approved' AND id != ?`
  ).bind(excludeId || -1).all();
  let maxCount = 0, conflictDate = null;
  const start = new Date(from), end = new Date(to);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dayStr = d.toISOString().split('T')[0];
    const count = results.filter(r => r.from_date <= dayStr && dayStr <= r.to_date).length + 1;
    if (count > maxCount) { maxCount = count; conflictDate = dayStr; }
  }
  return { count: maxCount, date: conflictDate };
}

// Approved-leave days for a given month, shaped for the schedule generator:
// { staffId: Set(dayOfMonth) }
export async function approvedLeaveDaysForMonth(db, year, month) {
  const monthStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthEnd = `${year}-${String(month + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
  const { results } = await db.prepare(
    `SELECT staff_id, from_date, to_date FROM leave_requests
     WHERE status = 'approved' AND from_date <= ? AND to_date >= ?`
  ).bind(monthEnd, monthStart).all();

  const map = {};
  for (const r of results) {
    const start = new Date(Math.max(new Date(r.from_date), new Date(monthStart)));
    const end = new Date(Math.min(new Date(r.to_date), new Date(monthEnd)));
    if (!map[r.staff_id]) map[r.staff_id] = new Set();
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      map[r.staff_id].add(d.getDate());
    }
  }
  return map;
}

// ── Swaps ──────────────────────────────────────────────
export async function listSwaps(db) {
  const { results } = await db.prepare(
    'SELECT * FROM swap_requests ORDER BY submitted_at DESC, id DESC'
  ).all();
  return results.map(rowToSwap);
}
function rowToSwap(r) {
  return {
    id: r.id, from: r.from_staff, fromName: r.from_name, to: r.to_staff, toName: r.to_name,
    fromDate: r.from_date, fromShift: r.from_shift, toDate: r.to_date, toShift: r.to_shift,
    status: r.status, submitted: r.submitted_at.split('T')[0],
  };
}

export async function createSwapRequest(db, { from, fromName, to, toName, fromDate, fromShift, toDate, toShift }) {
  const submitted = new Date().toISOString();
  const res = await db.prepare(
    `INSERT INTO swap_requests (from_staff, from_name, to_staff, to_name, from_date, from_shift, to_date, to_shift, status, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).bind(from, fromName, to, toName, fromDate, fromShift, toDate, toShift, submitted).run();
  return res.meta.last_row_id;
}

export async function getSwapRequest(db, id) {
  const r = await db.prepare('SELECT * FROM swap_requests WHERE id = ?').bind(id).first();
  return r ? rowToSwap(r) : null;
}

export async function resolveSwapRequest(db, id, status) {
  await db.prepare('UPDATE swap_requests SET status = ?, resolved_at = ? WHERE id = ?')
    .bind(status, new Date().toISOString(), id).run();
}

// ── Schedule overrides ──────────────────────────────────────────────
export async function overridesForMonth(db, year, month) {
  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
  const { results } = await db.prepare(
    'SELECT staff_id, date, shift, covering FROM schedule_overrides WHERE date LIKE ?'
  ).bind(`${monthPrefix}%`).all();
  return results;
}

export async function upsertOverride(db, staffId, date, shift, covering) {
  await db.prepare(
    'INSERT INTO schedule_overrides (staff_id, date, shift, covering) VALUES (?, ?, ?, ?) ON CONFLICT(staff_id, date) DO UPDATE SET shift = excluded.shift, covering = excluded.covering'
  ).bind(staffId, date, shift, covering ? 1 : 0).run();
}

// ── Activity log ──────────────────────────────────────────────
export async function logActivity(db, type, icon, title, sub) {
  await db.prepare('INSERT INTO activities (type, icon, title, sub) VALUES (?, ?, ?, ?)')
    .bind(type, icon, title, sub || '').run();
}

export async function listActivities(db, limit) {
  const { results } = await db.prepare(
    'SELECT type, icon, title, sub, created_at FROM activities ORDER BY created_at DESC, id DESC LIMIT ?'
  ).bind(limit || 20).all();
  return results;
}
