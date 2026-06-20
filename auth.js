// ── Schedule generator — server-side port of the original client algorithm ──
// Pure function: given the current staff roster and a map of approved-leave
// days for this month, deterministically produces the full schedule grid.
//
// Hard rules (unchanged from the original client-side implementation):
//   ISOC: EXACTLY 3 Day (D) + EXACTLY 3 Night (N), every day. Never more, never less.
//   SCE:  EXACTLY 2 Day (DC) + EXACTLY 1 Night (NC), every day. Never more, never less.
//   12-hr rest: staff who worked Night (N/NC) cannot work Day (D/DC) the very next day.
//   Max consecutive working days: 4 normally, 5 only if absolutely unavoidable. Leave
//     counts as a working day toward this cap — it does NOT earn or substitute for an off day.
//   Cross-cover: SCE staff regularly rotate into ISOC's D/N slots (shown as plain D/N, not
//     DC/NC, and flagged 'covering: true') — a STANDING fairness mechanism, since ISOC
//     structurally needs more workdays/person than SCE. Capped at MAX_SCE_SUBS_PER_DAY/day.
//   Fairness: total workdays (work+leave) balanced as evenly as possible across ALL staff,
//     ISOC and SCE combined — not just within department.
//
// `leaveDaysMap` is `{ staffId: Set<dayOfMonth> }`, built from approved leave_requests
// rows that overlap the target month (see db.js#approvedLeaveDaysForMonth).
export function generateSchedule(staffList, leaveDaysMap, year, month) {
  const days = new Date(year, month + 1, 0).getDate();
  const schedule = {};
  const covering = {};
  for (const s of staffList) { schedule[s.id] = {}; covering[s.id] = {}; }

  for (const [sid, daySet] of Object.entries(leaveDaysMap)) {
    if (!schedule[sid]) continue; // staff member no longer on roster — skip safely
    for (const d of daySet) schedule[sid][d] = 'L';
  }

  function canDoDay(sid, d) {
    if (d <= 1) return true;
    const prev = schedule[sid][d - 1];
    return prev !== 'N' && prev !== 'NC';
  }

  function consecutiveStreak(sid, d) {
    let streak = 0;
    for (let k = d - 1; k >= 1; k--) {
      const sh = schedule[sid][k];
      if (sh === 'O' || sh === 'L' || sh === undefined) break;
      streak++;
    }
    return streak;
  }

  const workCount = {};
  for (const s of staffList) workCount[s.id] = 0;

  function isEligible(sid, d, hardCapOnly) {
    if (schedule[sid][d] === 'L') return false;
    const streak = consecutiveStreak(sid, d);
    if (hardCapOnly) return streak < 5;
    return streak < 4;
  }

  const isocIds = staffList.filter(s => s.dept === 'ISOC').map(s => s.id);
  const sceIds  = staffList.filter(s => s.dept === 'SCE').map(s => s.id);
  const allIds  = staffList.map(s => s.id);
  const MAX_SCE_SUBS_PER_DAY = 2;

  for (let d = 1; d <= days; d++) {
    for (const sid of allIds) {
      if (schedule[sid][d] === 'L') workCount[sid]++;
    }

    function pickPool(deptIds, excludeIds) {
      let pool = deptIds.filter(sid => !excludeIds.includes(sid) && schedule[sid][d] !== 'L');
      let soft = pool.filter(sid => isEligible(sid, d, false));
      return { soft, hard: pool.filter(sid => isEligible(sid, d, true)) };
    }

    function takeN(softList, hardList, n, filterFn) {
      let softFiltered = softList.filter(filterFn).sort((a, b) => workCount[a] - workCount[b]);
      let picks = softFiltered.slice(0, n);
      if (picks.length < n) {
        let hardFiltered = hardList.filter(sid => !picks.includes(sid)).filter(filterFn).sort((a, b) => workCount[a] - workCount[b]);
        picks = picks.concat(hardFiltered.slice(0, n - picks.length));
      }
      return picks;
    }

    const isocPool = pickPool(isocIds, []);
    const isocDayPicks = takeN(isocPool.soft, isocPool.hard, 3, sid => canDoDay(sid, d));
    const isocRemSoft = isocPool.soft.filter(sid => !isocDayPicks.includes(sid));
    const isocRemHard = isocPool.hard.filter(sid => !isocDayPicks.includes(sid));
    const isocNightPicks = takeN(isocRemSoft, isocRemHard, 3, () => true);

    const scePool = pickPool(sceIds, []);
    const sceDayPicks = takeN(scePool.soft, scePool.hard, 2, sid => canDoDay(sid, d));
    const sceRemainingSoft = scePool.soft.filter(sid => !sceDayPicks.includes(sid));
    const sceRemainingHard = scePool.hard.filter(sid => !sceDayPicks.includes(sid));
    const sceNightPicks = takeN(sceRemainingSoft, sceRemainingHard, 1, () => true);

    function fillShortfall(picks, need, excludeAlreadyUsed, filterFn) {
      if (picks.length >= need) return picks;
      const used = new Set([...isocDayPicks, ...isocNightPicks, ...sceDayPicks, ...sceNightPicks, ...excludeAlreadyUsed]);
      const fallbackPool = allIds.filter(sid => !used.has(sid) && schedule[sid][d] !== 'L');
      const eligible = fallbackPool.filter(sid => isEligible(sid, d, true) && filterFn(sid))
        .sort((a, b) => workCount[a] - workCount[b]);
      const extra = eligible.slice(0, need - picks.length);
      for (const sid of extra) { if (sceIds.includes(sid)) covering[sid][d] = true; }
      return picks.concat(extra);
    }
    let isocDayFinal   = fillShortfall(isocDayPicks,   3, [], sid => canDoDay(sid, d));
    let isocNightFinal = fillShortfall(isocNightPicks, 3, isocDayFinal, () => true);

    const sceUsedToday = new Set([...sceDayPicks, ...sceNightPicks]);
    const sceIdlePool = sceIds.filter(sid => !sceUsedToday.has(sid) && schedule[sid][d] !== 'L')
      .filter(sid => isEligible(sid, d, false));

    let subsUsed = 0;
    const rosterSlots = [
      ...isocDayFinal.map(sid => ({ sid, type: 'D' })),
      ...isocNightFinal.map(sid => ({ sid, type: 'N' })),
    ];
    const sceVolunteers = [...sceIdlePool].sort((a, b) => workCount[a] - workCount[b]);

    for (const volunteer of sceVolunteers) {
      if (subsUsed >= MAX_SCE_SUBS_PER_DAY) break;
      let bestSlotIdx = -1, bestWorkCount = -1;
      for (let i = 0; i < rosterSlots.length; i++) {
        const slot = rosterSlots[i];
        if (covering[slot.sid] && covering[slot.sid][d]) continue;
        if (slot.type === 'D' && !canDoDay(volunteer, d)) continue;
        if (workCount[volunteer] >= workCount[slot.sid]) continue;
        if (workCount[slot.sid] > bestWorkCount) { bestWorkCount = workCount[slot.sid]; bestSlotIdx = i; }
      }
      if (bestSlotIdx === -1) continue;

      const replaced = rosterSlots[bestSlotIdx].sid;
      const type = rosterSlots[bestSlotIdx].type;
      if (type === 'D') {
        isocDayFinal = isocDayFinal.filter(sid => sid !== replaced);
        isocDayFinal.push(volunteer);
      } else {
        isocNightFinal = isocNightFinal.filter(sid => sid !== replaced);
        isocNightFinal.push(volunteer);
      }
      rosterSlots[bestSlotIdx] = { sid: volunteer, type };
      covering[volunteer][d] = true;
      subsUsed++;
    }

    for (const sid of isocDayFinal)   { schedule[sid][d] = 'D'; workCount[sid]++; }
    for (const sid of isocNightFinal) { schedule[sid][d] = 'N'; workCount[sid]++; }
    for (const sid of sceDayPicks)    { schedule[sid][d] = 'DC'; workCount[sid]++; }
    for (const sid of sceNightPicks)  { schedule[sid][d] = 'NC'; workCount[sid]++; }
    for (const sid of allIds)         { if (!schedule[sid][d]) schedule[sid][d] = 'O'; }
  }

  return { schedule, covering };
}

// Approved-swap overrides are stored per (staff_id, date) cell and applied on
// top of the deterministically generated grid — see db.js#overridesForMonth.
export function applyOverrides(schedule, covering, overrideRows) {
  for (const row of overrideRows) {
    const day = parseInt(row.date.split('-')[2], 10);
    if (!schedule[row.staff_id]) continue;
    schedule[row.staff_id][day] = row.shift;
    covering[row.staff_id][day] = !!row.covering;
  }
}

// Coverage-rule check used both when a swap is *requested* (instant feedback)
// and again, authoritatively, when an admin *approves* it (roster may have
// changed in between). Mirrors the original client-side wouldSwapBreakCoverage.
export function checkSwapCoverage(staffList, scheduleA, dayA, staffA, newShiftA, scheduleB, dayB, staffB, newShiftB) {
  function countDept(schedule, dept, day, types) {
    return staffList.filter(s => s.dept === dept)
      .filter(s => types.includes(schedule[s.id]?.[day]))
      .length;
  }
  const problems = [];
  const fromDept = staffList.find(s => s.id === staffA)?.dept;
  const toDept   = staffList.find(s => s.id === staffB)?.dept;

  const simA = { ...scheduleA, [staffA]: { ...scheduleA[staffA], [dayA]: newShiftA } };
  if (fromDept === 'ISOC') {
    const dCount = countDept(simA, 'ISOC', dayA, ['D']);
    const nCount = countDept(simA, 'ISOC', dayA, ['N']);
    if (dCount !== 3) problems.push(`ISOC Day understaffed on day ${dayA}: ${dCount}/3`);
    if (nCount !== 3) problems.push(`ISOC Night understaffed on day ${dayA}: ${nCount}/3`);
  } else {
    const dcCount = countDept(simA, 'SCE', dayA, ['DC']);
    const ncCount = countDept(simA, 'SCE', dayA, ['NC']);
    if (dcCount !== 2) problems.push(`SCE Day understaffed on day ${dayA}: ${dcCount}/2`);
    if (ncCount !== 1) problems.push(`SCE Night understaffed on day ${dayA}: ${ncCount}/1`);
  }

  const simB = { ...scheduleB, [staffB]: { ...scheduleB[staffB], [dayB]: newShiftB } };
  if (toDept === 'ISOC') {
    const dCount = countDept(simB, 'ISOC', dayB, ['D']);
    const nCount = countDept(simB, 'ISOC', dayB, ['N']);
    if (dCount !== 3) problems.push(`ISOC Day understaffed on day ${dayB}: ${dCount}/3`);
    if (nCount !== 3) problems.push(`ISOC Night understaffed on day ${dayB}: ${nCount}/3`);
  } else {
    const dcCount = countDept(simB, 'SCE', dayB, ['DC']);
    const ncCount = countDept(simB, 'SCE', dayB, ['NC']);
    if (dcCount !== 2) problems.push(`SCE Day understaffed on day ${dayB}: ${dcCount}/2`);
    if (ncCount !== 1) problems.push(`SCE Night understaffed on day ${dayB}: ${ncCount}/1`);
  }

  if ((newShiftA === 'D' || newShiftA === 'DC')) {
    const prev = scheduleA[staffA]?.[dayA - 1];
    if (prev === 'N' || prev === 'NC') problems.push(`No rest before day shift on day ${dayA}`);
  }
  if ((newShiftB === 'D' || newShiftB === 'DC')) {
    const prev = scheduleB[staffB]?.[dayB - 1];
    if (prev === 'N' || prev === 'NC') problems.push(`No rest before day shift on day ${dayB}`);
  }

  return { broken: problems.length > 0, problems };
}
