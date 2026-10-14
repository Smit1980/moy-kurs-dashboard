(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DashboardIndicators = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const statusMeta = {
    neutral: { label: 'Ожидает факта', icon: '○', className: 'neutral' },
    progress: { label: 'В процессе', icon: '◐', className: 'progress' },
    missing: { label: 'Нет отметки', icon: '!', className: 'missing' },
    behind: { label: 'План не выполнен', icon: '×', className: 'behind' },
    complete: { label: 'План выполнен', icon: '✓', className: 'complete' }
  };
  const dayOffsets = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4 };
  const hasFact = value => value !== null && value !== undefined && value !== '';
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;

  function moscowDate(now) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    const pick = type => parts.find(part => part.type === type).value;
    return `${pick('year')}-${pick('month')}-${pick('day')}`;
  }

  function dateForSlot(weekStart, day) {
    if (!weekStart || !(day in dayOffsets)) return '';
    const date = new Date(`${weekStart}T12:00:00`);
    date.setDate(date.getDate() + dayOffsets[day]);
    return date.toLocaleDateString('sv-SE');
  }

  function slotStatus(slot, scheduledDate, currentDate) {
    const planned = finite(slot.hours);
    const actualKnown = hasFact(slot.actualHours);
    const actual = finite(slot.actualHours);
    const past = Boolean(scheduledDate && scheduledDate < currentDate);
    let key = 'neutral';
    if (!actualKnown) key = past ? 'missing' : 'neutral';
    else if (actual >= planned) key = 'complete';
    else key = past ? 'behind' : 'progress';
    return {
      key,
      ...statusMeta[key],
      planned,
      actual: actualKnown ? actual : null,
      scheduledDate,
      excess: actualKnown && actual > planned ? actual - planned : 0,
      remaining: actualKnown ? Math.max(0, planned - actual) : planned
    };
  }

  function aggregateStatus(items) {
    const statuses = items.map(item => typeof item === 'string' ? item : item.key);
    const counts = statuses.reduce((all, key) => { all[key] = (all[key] || 0) + 1; return all; }, {});
    const nonNeutral = Object.keys(counts).filter(key => key !== 'neutral');
    const key = counts.behind ? 'behind'
      : counts.missing ? 'missing'
        : counts.progress ? 'progress'
          : statuses.length > 0 && statuses.every(status => status === 'complete') ? 'complete'
            : 'neutral';
    const labels = [
      counts.behind && `${counts.behind} не выполнен${counts.behind === 1 ? '' : 'о'}`,
      counts.missing && `${counts.missing} без отметки`,
      counts.progress && `${counts.progress} в процессе`,
      counts.complete && `${counts.complete} выполнен${counts.complete === 1 ? '' : 'о'}`
    ].filter(Boolean);
    return { key, ...statusMeta[key], counts, mixed: nonNeutral.length > 1, description: labels.join(', ') || statusMeta.neutral.label };
  }

  function goalStatus(goal, checkpoints, currentDate) {
    const overdue = Boolean(goal.deadline && goal.deadline < currentDate);
    const knownTarget = hasFact(goal.target) && finite(goal.target) > 0;
    const knownCurrent = hasFact(goal.current);
    const points = checkpoints || [];
    const pointStates = points.map(point => point.done ? 'complete' : point.due && point.due < currentDate ? 'missing' : 'neutral');
    if (goal.status === 'done') return { key: 'complete', ...statusMeta.complete, source: 'goal-status' };
    if (knownTarget && knownCurrent && finite(goal.current) >= finite(goal.target)) return { key: 'complete', ...statusMeta.complete, source: 'metric' };
    if (overdue && knownTarget && knownCurrent && finite(goal.current) < finite(goal.target)) return { key: 'behind', ...statusMeta.behind, source: 'metric' };
    if (knownTarget && !knownCurrent) {
      if (overdue) return { key: 'missing', ...statusMeta.missing, source: 'metric' };
      return { key: 'neutral', ...statusMeta.neutral, label: 'Нет факта', source: 'metric' };
    }
    if (knownTarget && knownCurrent) return { key: 'progress', ...statusMeta.progress, source: 'metric' };
    if (points.length && points.every(point => point.done)) return { key: 'complete', ...statusMeta.complete, source: 'checkpoint' };
    const pointSummary = aggregateStatus(pointStates);
    if (pointSummary.key === 'missing') return { key: 'missing', ...statusMeta.missing, source: 'checkpoint' };
    if (points.some(point => point.done)) return { key: 'progress', ...statusMeta.progress, source: 'checkpoint' };
    if (overdue) return { key: 'missing', ...statusMeta.missing, source: 'metric' };
    return { key: 'neutral', ...statusMeta.neutral, label: points.length ? statusMeta.neutral.label : 'Нет критерия', source: 'unknown' };
  }

  return { statusMeta, hasFact, moscowDate, dateForSlot, slotStatus, aggregateStatus, goalStatus };
});
