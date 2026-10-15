(() => {
  'use strict';
  const statuses = { draft: 'Уточнить', active: 'В работе', paused: 'Пауза', done: 'Достигнута' };
  const weekdays = { mon: 'Понедельник', tue: 'Вторник', wed: 'Среда', thu: 'Четверг', fri: 'Пятница' };
  const shortDays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'];
  const colors = ['#232323', '#a6a385', '#ddd71a', '#7c8b7a', '#b8b8b0', '#6c665e', '#c4bc8e'];
  const indicators = globalThis.DashboardIndicators;
  const $ = selector => document.querySelector(selector);
  const clone = value => JSON.parse(JSON.stringify(value));
  const number = value => Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  const today = () => indicators ? indicators.moscowDate(new Date()) : new Date().toLocaleDateString('sv-SE');
  const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const formatDate = value => value ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00`)) : 'Без срока';
  const dateShift = (value, days) => { const d = new Date(`${value}T12:00:00`); d.setDate(d.getDate() + days); return d.toLocaleDateString('sv-SE'); };
  const monday = value => { const d = new Date(`${value}T12:00:00`); return dateShift(value, -((d.getDay() + 6) % 7)); };
  const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = String(text); return n; };
  const add = (parent, ...children) => { parent.append(...children); return parent; };
  function button(label, className, action, editable = true) {
    const n = el('button', className, label); n.type = 'button';
    if (editable) n.dataset.edit = '';
    n.addEventListener('click', action); return n;
  }
  const apiBase = (globalThis.DASHBOARD_CONFIG?.apiBase || '').replace(/\/$/, '');
  let state = null, revision = 0, authenticated = false, csrfToken = '', sessionToken = '', saving = false, selectedWeek = '', authEpoch = 0, familyEntries = [];
  const staleFormMessage = 'План изменился. Правки в этой форме не сохранены. Скопируйте нужный текст, закройте форму и откройте актуальную запись заново.';
  const staleForm = form => form && (form.dataset.stale === 'true' || form.dataset.baseRevision !== undefined && Number(form.dataset.baseRevision) !== revision || form.dataset.weekStart && form.dataset.weekStart !== selectedWeek);

  function notify(message) {
    const toast = $('#toast'); toast.textContent = message; toast.classList.add('visible');
    clearTimeout(notify.timer); notify.timer = setTimeout(() => toast.classList.remove('visible'), 5000);
  }
  async function api(path, method = 'GET', body) {
    let response;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
    try {
      response = await fetch(`${apiBase}/api/${path}`, { method, signal: controller.signal, credentials: apiBase ? 'omit' : 'same-origin', cache: 'no-store', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new Error('Нет связи с сервером. Проверьте подключение и повторите сохранение.'); }
    finally { clearTimeout(timeout); }
    let data; try { data = await response.json(); } catch { throw new Error('Сервер вернул непонятный ответ. Изменения не подтверждены.'); }
    if (!response.ok) {
      const messages = { 400: 'Проверьте формат полей: сервер не принял данные.', 401: 'Нужен повторный вход.', 403: 'Сессия не разрешает сохранение. Войдите заново.', 409: 'План изменён в другой вкладке или на другом устройстве. Изменения не сохранены. Обновите страницу перед новой правкой.', 413: 'Копия слишком большая. Максимум — 1 МБ.', 429: 'Слишком много попыток. Подождите минуту и повторите вход.' };
      const error = new Error(messages[response.status] || 'Не удалось сохранить данные на сервере.'); error.status = response.status; throw error;
    }
    return data;
  }
  function setControls() {
    document.querySelectorAll('[data-edit], .editor:not(.login-dialog) button[type="submit"]').forEach(n => { n.disabled = Boolean(!authenticated || saving || staleForm(n.closest('form'))); });
    $('#authButton').disabled = saving;
    $('#refreshButton').disabled = saving;
    $('#authButton').textContent = authenticated ? 'Заблокировать' : state ? 'Редактировать' : 'Войти';
    $('#readOnlyNote').hidden = authenticated;
  }
  function formError(form, message = '') {
    const node = form.querySelector('.form-error'); if (node) { node.textContent = message; node.hidden = !message; }
  }
  function beginSave() { if (saving) return false; saving = true; setControls(); $('#saveStatus').textContent = 'Сохраняем…'; $('.sync-dot')?.setAttribute('data-state', 'saving'); return true; }
  function endSave(ok) { saving = false; $('#saveStatus').textContent = ok ? 'Все изменения сохранены' : 'Изменения не сохранены'; $('.sync-dot')?.setAttribute('data-state', ok ? 'saved' : 'error'); setControls(); }
  function expireSession() { authenticated = false; csrfToken = ''; sessionToken = ''; authEpoch++; familyEntries = []; globalThis.DashboardFinance?.clear(); setControls(); renderFamilyTime(); }
  async function loadState() {
    const result = await api('state'); state = result.state; revision = result.revision;
    if (!selectedWeek) selectedWeek = monday(today());
    $('#lockedScreen').hidden = true; $('#workspace').hidden = false;
    $('#connectionError').hidden = true;
    $('#updatedAt').textContent = `Обновлено ${new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(new Date())}`;
    $('#saveStatus').textContent = 'Все изменения сохранены'; $('.sync-dot')?.setAttribute('data-state', 'saved'); render(); globalThis.DashboardFinance?.render();
  }
  async function loadFamilyTime() {
    if (!authenticated) { familyEntries = []; renderFamilyTime(); return; }
    try { const data = await api('family-time'); familyEntries = data.entries || []; renderFamilyTime(); }
    catch (error) { familyEntries = []; renderFamilyTime(); if (error.status === 401 || error.status === 403) expireSession(); else notify(`Личное расписание не загружено: ${error.message}`); }
  }
  async function mutate(change, form) {
    if (!authenticated || saving) { if (!authenticated) openLogin(); return false; }
    if (staleForm(form)) { formError(form, staleFormMessage); setControls(); return false; }
    const draft = clone(state); change(draft);
    saving = true; setControls(); $('#saveStatus').textContent = 'Сохраняем…'; $('.sync-dot')?.setAttribute('data-state', 'saving'); if (form) formError(form);
    try {
      const result = await api('state', 'PUT', { state: draft, revision });
      state = result.state; revision = result.revision;
      $('#saveStatus').textContent = 'Все изменения сохранены'; $('.sync-dot')?.setAttribute('data-state', 'saved'); render(); notify('Сохранено'); return true;
    } catch (error) {
      if (error.status === 401 || error.status === 403) expireSession();
      if (error.status === 409) {
        // Keep typed text available to copy, but never apply it to a different revision/week.
        document.querySelectorAll('.editor:not(.login-dialog)[open] form').forEach(openForm => { openForm.dataset.stale = 'true'; formError(openForm, staleFormMessage); });
        try { await loadState(); error.message = form ? staleFormMessage : 'Загружена актуальная версия плана. Изменения не сохранены; повторите действие.'; }
        catch { error.message = 'Не удалось загрузить актуальный план. Изменения не сохранены. Обновите страницу после восстановления связи.'; }
      }
      $('#saveStatus').textContent = 'Изменения не сохранены'; $('.sync-dot')?.setAttribute('data-state', 'error'); if (form) formError(form, error.message); notify(error.message); return false;
    } finally { saving = false; render(); }
  }
  const goalName = goalId => state.goals.find(g => g.id === goalId)?.title || 'Цель из архива';
  const selectedWeekData = (source = state, start = selectedWeek) => {
    if (!source || !start) return null;
    if (source.weekStart === start) return { weekStart: source.weekStart, capacity: source.capacity, schedule: source.schedule, current: true };
    const archived = (source.weekHistory || []).find(week => week.weekStart === start);
    return archived ? { ...archived, current: false } : null;
  };
  const selectedSchedule = (source = state, start = selectedWeek) => selectedWeekData(source, start)?.schedule || [];
  const selectedCapacity = (source = state, start = selectedWeek) => selectedWeekData(source, start)?.capacity ?? source?.capacity ?? 0;
  const selectedStored = () => Boolean(selectedWeekData());
  const selectedWeekLabel = () => selectedWeek === state.weekStart ? 'основная неделя' : selectedStored() ? 'архивная неделя' : 'пустая неделя';
  const updateSelectedWeek = (draft, change) => {
    if (selectedWeek === draft.weekStart) return change(draft);
    const archived = (draft.weekHistory || []).find(week => week.weekStart === selectedWeek);
    if (!archived) return false;
    return change(archived);
  };
  const sum = (slots, field = 'hours') => slots.reduce((total, s) => total + (Number(s[field]) || 0), 0);
  const recorded = slots => slots.filter(s => s.actualHours !== null && s.actualHours !== undefined);
  const slotDate = slot => indicators.dateForSlot(selectedWeek, slot.day);
  const statusFor = slot => indicators.slotStatus(slot, slotDate(slot), today());
  function statusNode(status, extra = '') {
    const node = el('span', `status-indicator status-${status.className || status.key} ${extra}`.trim(), status.icon);
    node.title = status.description || status.label;
    node.setAttribute('aria-label', status.description || status.label);
    return node;
  }
  function ring(progress, label, className = 'hours-ring', status) {
    const known = Number.isFinite(progress);
    const safeProgress = known ? Math.min(100, Math.max(0, progress)) : 0;
    const node = el('span', `${className}${status ? ` ring-status-${status.key}` : ''}${known ? '' : ' ring-unknown'}`);
    node.style.setProperty('--progress', `${safeProgress}%`);
    node.title = label;
    node.setAttribute('aria-label', label);
    node.append(el('span', '', known ? `${Math.round(safeProgress)}%` : '—'));
    return node;
  }
  function goalProgress(goal, points) {
    if (goal.status === 'done') return 100;
    if (goal.target !== null && goal.target !== undefined && goal.target !== '' && Number(goal.target) > 0) {
      if (goal.current === null || goal.current === undefined || goal.current === '') return null;
      return Math.min(100, Math.max(0, Number(goal.current) / Number(goal.target) * 100));
    }
    return points.length ? points.filter(point => point.done).length / points.length * 100 : null;
  }

  function renderSummary() {
    $('#todayLabel').textContent = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
    $('#activeCount').textContent = state.goals.filter(g => g.status === 'active').length;
    $('#plannedSummary').textContent = number(sum(selectedSchedule()));
    $('#doneCount').textContent = state.checkpoints.filter(c => c.done).length;
    $('#lastReview').textContent = state.reviews.length ? formatDate([...state.reviews].sort((a, b) => b.at.localeCompare(a.at))[0].at.slice(0, 10)) : '—';
    const focus = [...state.checkpoints].filter(c => !c.done).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'))[0];
    $('#focusTitle').textContent = focus?.title || 'Все точки пройдены. Что дальше?';
    $('#focusText').textContent = focus ? `${goalName(focus.goalId)} · ${formatDate(focus.due)}` : 'Добавьте следующий проверяемый шаг.';
  }
  function renderFilters() {
    const select = $('#areaFilter'), selected = select.value;
    const all = el('option', '', 'Все направления'); all.value = 'all'; select.replaceChildren(all);
    [...new Set(state.goals.map(g => g.area))].sort().forEach(area => { const option = el('option', '', area); option.value = area; select.append(option); });
    select.value = [...select.options].some(o => o.value === selected) ? selected : 'all';
  }
  function renderGoals() {
    const container = $('#goalGrid'); container.replaceChildren();
    const area = $('#areaFilter').value, status = $('#statusFilter').value, query = ($('#goalSearch')?.value || '').trim().toLocaleLowerCase('ru-RU');
    const goals = state.goals.filter(g => (area === 'all' || g.area === area) && (status === 'all' || g.status === status) && (!query || `${g.title} ${g.area} ${g.outcome || ''}`.toLocaleLowerCase('ru-RU').includes(query)));
    if (!goals.length) container.append(el('p', 'empty', 'Здесь пока нет целей. Добавьте цель или измените фильтр.'));
    for (const goal of goals) {
      const card = el('article', 'goal-card'), top = el('div', 'goal-topline');
      add(top, el('span', 'area-chip', goal.area), el('span', `badge status-${goal.status}`, statuses[goal.status]));
      const points = state.checkpoints.filter(c => c.goalId === goal.id), goalIndicator = indicators.goalStatus(goal, points, today());
      const goalProgressValue = goalProgress(goal, points);
      const resultRing = button('', 'goal-ring-button', () => openGoal(goal.id), false);
      if (goal.status === 'done') goalIndicator.label = 'Отмечена как достигнутая';
      resultRing.append(ring(goalProgressValue, goalProgressValue === null ? 'Движение к результату: нет факта' : `Движение к результату: ${Math.round(goalProgressValue)}%`, 'goal-ring', goalIndicator));
      resultRing.append(statusNode(goalIndicator));
      resultRing.title = `${goalIndicator.label}. Нажмите, чтобы посмотреть показатель цели.`;
      top.append(resultRing);
      const metric = el('div', 'metric');
      if (goal.target !== null && goal.target !== undefined && goal.target !== '') {
        add(metric, el('strong', '', goal.current === null || goal.current === '' ? '—' : number(goal.current)), el('span', '', ` / ${number(goal.target)} ${goal.unit || ''}`));
        if (goal.current !== null && goal.current !== '' && Number(goal.target) > 0) {
          const track = el('div', 'progress-track'), fill = el('span', 'progress-bar'); fill.style.width = `${Math.min(100, Math.max(0, Number(goal.current) / Number(goal.target) * 100))}%`; track.append(fill); metric.append(track);
        } else metric.append(el('small', '', 'Фактическое значение ещё не внесено'));
      } else metric.append(el('small', '', goal.status === 'done' ? 'Результат отмечен вручную как достигнутый' : 'Результат оценивается по контрольным точкам'));
      const meta = el('div', 'goal-meta');
      add(meta, el('span', '', `Срок: ${formatDate(goal.deadline)}`), el('span', '', `${points.filter(c => c.done).length}/${points.length} точек`));
      if (goal.weeklyHours !== null && goal.weeklyHours !== undefined) meta.append(el('span', '', `Ориентир: ${number(goal.weeklyHours)} ч/нед`));
      const actions = el('div', 'goal-actions'); add(actions, button('Изменить цель ↗', 'text-button', () => openGoal(goal.id)), button('+ Точка', 'text-button', () => openCheckpoint(null, goal.id)));
      add(card, top, el('h3', '', goal.title), el('p', 'goal-outcome', goal.outcome || 'Укажите ожидаемый результат.'), metric, el('p', `goal-status-text status-text-${goalIndicator.key}`, `${goalIndicator.icon} ${goalIndicator.label}`), meta, actions);
      if (goal.note) { const details = el('details', 'goal-note'); add(details, el('summary', '', 'Основание и оговорки'), el('p', '', goal.note)); card.append(details); }
      container.append(card);
    }
    setControls();
  }
  function putText(id, value) { const node = $(id); if (node) node.textContent = value; }
  function renderWeekOverview(schedule, total, actual, weekIndicator) {
    const known = recorded(schedule), missing = schedule.filter(slot => statusFor(slot).key === 'missing'), behind = schedule.filter(slot => statusFor(slot).key === 'behind');
    const progress = total > 0 && known.length ? Math.min(100, actual / total * 100) : null;
    const progressNode = $('#weekProgress');
    if (progressNode) { progressNode.replaceChildren(ring(progress, progress === null ? 'Факт ещё не внесён' : `Внесено ${Math.round(progress)}% часов`, 'hours-ring week-progress-ring', weekIndicator)); }
    putText('#weekFact', known.length ? number(actual) : '—'); putText('#weekPlanTotal', number(total)); putText('#recordedCount', `${known.length}/${schedule.length}`); putText('#attentionCount', String(missing.length + behind.length));
    const attention = $('#attentionList');
    if (attention) {
      attention.replaceChildren();
      const items = [...behind, ...missing];
      if (!items.length) attention.append(el('p', 'empty', 'По этой неделе нет просроченных отметок.'));
      items.slice(0, 4).forEach(slot => {
        const indicator = statusFor(slot);
        const item = button('', `attention-item status-text-${indicator.key}`, () => openSlot(slot.id), false);
        const copy = el('span', 'attention-copy'); add(copy, el('strong', '', slot.title), el('small', '', `${weekdays[slot.day]} · ${indicator.label}`)); add(item, statusNode(indicator), copy); attention.append(item);
      });
      if (items.length > 4) attention.append(el('p', 'attention-more', `Ещё ${items.length - 4} пункт(а) в расписании.`));
    }
    const todaySlots = $('#todaySlots'), todaySummary = $('#todaySummary'), weekToday = monday(today());
    if (todaySlots) {
      todaySlots.replaceChildren();
      if (selectedWeek !== weekToday) {
        todaySlots.append(el('p', 'empty', 'Вы смотрите другую неделю.')); if (todaySummary) todaySummary.textContent = 'Сегодня вне выбранной недели';
      } else {
        const day = Object.keys(weekdays)[new Date(`${today()}T12:00:00`).getDay() - 1], items = schedule.filter(slot => slot.day === day);
        if (todaySummary) todaySummary.textContent = items.length ? `${number(sum(items))} ч план · ${recorded(items).length ? number(sum(recorded(items), 'actualHours')) : '—'} ч факт` : 'На сегодня блоков нет';
        if (!items.length) todaySlots.append(el('p', 'empty', 'На сегодня блоков нет.'));
        items.forEach(slot => { const item = button('', 'today-slot', () => openSlot(slot.id), false), indicator = statusFor(slot), copy = el('span', 'today-slot-copy'); add(copy, el('strong', '', slot.title), el('small', '', `${number(slot.hours)} ч план · ${slot.actualHours == null ? 'факт —' : `${number(slot.actualHours)} ч`}`)); add(item, statusNode(indicator), copy); todaySlots.append(item); });
      }
    }
    const strip = $('#weekDayStrip');
    if (strip) {
      strip.replaceChildren();
      Object.keys(weekdays).forEach((day, index) => {
        const items = schedule.filter(slot => slot.day === day), indicator = indicators.aggregateStatus(items.map(statusFor));
        const item = button('', `week-day-strip-item status-cell-${indicator.key}`, () => openDay(null, day), false);
        const date = dateShift(selectedWeek, index);
        item.title = `${formatDate(date)} · план / факт · ${indicator.description}`;
        if (date === today()) item.setAttribute('aria-current', 'date');
        add(item, el('small', '', `${shortDays[index]} · ${Number(date.slice(-2))}`), statusNode(indicator), el('strong', '', `${number(sum(items))} / ${recorded(items).length ? number(sum(recorded(items), 'actualHours')) : '—'} ч`)); strip.append(item);
      });
    }
  }
  function renderTime() {
    const schedule = selectedSchedule(), capacity = selectedCapacity(), total = sum(schedule), actual = sum(recorded(schedule), 'actualHours');
    const weekIndicator = indicators.aggregateStatus(schedule.map(statusFor));
    $('#weekStart').value = selectedWeek;
    if ($('#weekContext')) $('#weekContext').textContent = selectedStored() ? 'Просмотр недели не меняет общий план.' : 'План ещё не создан. После входа можно скопировать блоки основной недели.';
    if ($('#weekRange')) $('#weekRange').textContent = `${formatDate(selectedWeek)} — ${formatDate(dateShift(selectedWeek, 4))}`;
    if ($('#createWeek')) $('#createWeek').hidden = selectedStored();
    $('#capacityLabel').textContent = `${number(capacity)} ч`;
    $('#loadHours').textContent = `${number(total)} ч`;
    $('#loadDescription').textContent = `из ${number(capacity)} ч рабочего бюджета`;
    $('#freeHours').textContent = total > capacity ? `Перегрузка: ${number(total - capacity)} ч` : `Не распределено: ${number(capacity - total)} ч`;
    $('#freeHours').classList.toggle('overload', total > capacity);
    $('#actualSummary').textContent = recorded(schedule).length ? `Факт: ${number(actual)} ч · заполнено ${recorded(schedule).length}/${schedule.length} блоков · ${weekIndicator.description}` : `Факт ещё не внесён · ${weekIndicator.description}`;
    renderWeekOverview(schedule, total, actual, weekIndicator);
    renderDayCapacity(schedule);
    renderFamilyTime();
    const segments = $('#loadSegments'); segments.replaceChildren();
    const goals = state.goals.filter(g => g.status === 'active' || g.weeklyHours != null && g.status !== 'paused' && g.status !== 'done' || schedule.some(s => s.goalId === g.id));
    const matrix = $('#goalLoad'); matrix.replaceChildren();
    const head = el('div', 'goal-load-head'); add(head, el('span', '', 'Цель / ориентир'), el('span', '', 'План по дням, ч'), el('span', '', 'План / факт')); matrix.append(head);
    goals.forEach((goal, index) => {
      const slots = schedule.filter(s => s.goalId === goal.id), hours = sum(slots), known = recorded(slots), color = colors[index % colors.length], aggregate = indicators.aggregateStatus(slots.map(statusFor));
      if (hours > 0) { const segment = el('span', 'load-segment'); segment.style.width = `${hours / Math.max(capacity, total, 1) * 100}%`; segment.style.background = color; segment.title = `${goal.title}: ${number(hours)} ч`; segments.append(segment); }
      const row = el('article', 'goal-load-row'), label = el('div', 'goal-load-name');
      const dot = el('span', 'goal-color'); dot.style.background = color;
      add(label, dot, el('strong', '', goal.title), el('small', '', goal.area), el('small', '', goal.weeklyHours == null ? 'Ориентир не задан' : `Ориентир ${number(goal.weeklyHours)} ч`));
      label.title = goal.title;
      const days = el('div', 'goal-load-days');
      Object.keys(weekdays).forEach((day, dayIndex) => {
        const daySlots = slots.filter(s => s.day === day), dayHours = sum(daySlots), dayStatus = indicators.aggregateStatus(daySlots.map(statusFor));
        const cell = button('', `goal-load-day day-cell ${dayHours ? `has-hours status-cell-${dayStatus.key}` : ''}`, () => openDay(goal.id, day), false);
        cell.setAttribute('aria-label', `${goal.title}, ${weekdays[day]}: ${number(dayHours)} ч. ${dayStatus.description}. Открыть блоки`);
        add(cell, el('small', '', shortDays[dayIndex]), el('strong', '', dayHours ? number(dayHours) : '—'), dayHours ? statusNode(dayStatus) : el('span', 'status-indicator empty-status', '')); days.append(cell);
      });
      const totalCell = el('div', 'goal-load-total'); add(totalCell, statusNode(aggregate), el('strong', '', `${number(hours)} / ${known.length ? number(sum(known, 'actualHours')) : '—'}`), el('small', '', aggregate.description));
      if (goal.weeklyHours != null && hours < goal.weeklyHours) totalCell.append(el('small', 'load-gap', `ещё ${number(goal.weeklyHours - hours)} до ориентира`));
      add(row, label, days, totalCell); matrix.append(row);
    });
    if (!goals.length) matrix.append(el('p', 'empty', 'Добавьте цель и первый блок недели.'));
    const plan = $('#weekPlan'); plan.replaceChildren();
    Object.entries(weekdays).forEach(([day, name], i) => {
      const slots = schedule.filter(s => s.day === day), dayIndicator = indicators.aggregateStatus(slots.map(statusFor)), card = el('article', `day-column ${slots.length ? `day-status-${dayIndicator.key}` : ''}`);
      const dayTitle = el('h3', `day-heading ${slots.length ? `status-text-${dayIndicator.key}` : ''}`); add(dayTitle, el('span', '', name), slots.length ? statusNode(dayIndicator) : el('span', 'status-indicator empty-status', ''));
      const dateLine = el('p', `day-total ${slots.length ? `status-text-${dayIndicator.key}` : ''}`, `${formatDate(dateShift(selectedWeek, i))} · ${number(sum(slots))} ч · ${slots.length ? dayIndicator.description : 'нет блоков'}`);
      add(card, dayTitle, dateLine);
      for (const slot of slots) {
        const row = button('', 'slot', () => openSlot(slot.id), false);
        const slotIndicator = statusFor(slot), planned = Number(slot.hours) || 0, progress = slot.actualHours == null ? null : Math.min(100, Number(slot.actualHours) / Math.max(planned, 0.01) * 100);
        const dial = ring(progress, `${slotIndicator.label}: ${slot.actualHours == null ? 'нет факта' : number(slot.actualHours)} из ${number(planned)} часов`, 'hours-ring', slotIndicator);
        add(row, dial, statusNode(slotIndicator), el('strong', '', slot.title), el('span', '', `${number(slot.hours)} ч план · ${slot.actualHours == null ? 'факт —' : `${number(slot.actualHours)} ч факт`}${slotIndicator.excess ? ` · +${number(slotIndicator.excess)} ч сверх плана` : ''}`), el('small', `slot-status status-text-${slotIndicator.key}`, slotIndicator.label)); card.append(row);
      }
      if (!slots.length) card.append(el('p', 'empty', 'Пока нет блоков'));
      card.append(button('+ Блок', 'text-button', () => openSlot(null, day))); plan.append(card);
    });
  }
  function renderDayCapacity(schedule) {
    const grid = $('#dayCapacityGrid'); if (!grid) return;
    grid.replaceChildren();
    Object.entries(weekdays).forEach(([day, name], index) => {
      const used = sum(schedule.filter(slot => slot.day === day)), free = Math.max(0, 5 - used), over = Math.max(0, used - 5);
      const card = el('article', `day-capacity-card ${over ? 'capacity-over' : free === 0 ? 'capacity-full' : 'capacity-open'}`);
      const title = el('div', 'day-capacity-heading'); add(title, el('strong', '', shortDays[index]), el('span', '', name));
      const meter = el('div', 'capacity-meter'); meter.setAttribute('role', 'img'); meter.setAttribute('aria-label', over ? `Перегрузка ${number(over)} рабочих часов` : `Свободно ${number(free)} из 5 рабочих часов`); meter.style.setProperty('--used', `${Math.min(100, used / 5 * 100)}%`);
      const detail = over ? `Перегрузка ${number(over)} ч` : `Свободно ${number(free)} / 5 ч`;
      add(card, title, meter, el('strong', 'capacity-detail', detail), el('small', '', `В плане ${number(used)} ч`)); grid.append(card);
    });
  }
  function renderFamilyTime() {
    const grid = $('#familyTimeGrid'); if (!grid) return;
    grid.replaceChildren();
    if (!authenticated) { grid.append(el('p', 'family-time-locked', 'Войдите, чтобы увидеть или заполнить личное расписание.')); return; }
    Object.entries(weekdays).forEach(([day, name], index) => {
      const entry = familyEntries.find(item => item.weekStart === selectedWeek && item.day === day);
      const card = el('article', 'family-time-card'), heading = el('strong', '', shortDays[index]);
      const context = el('select'); context.setAttribute('aria-label', `${name}: режим дня`);
      [['kindergarten', 'В садике'], ['home', 'Дома / болеет']].forEach(([value, label]) => { const option = el('option', '', label); option.value = value; context.append(option); });
      const time = el('input'); time.type = 'time'; time.required = true; time.setAttribute('aria-label', `${name}: начало времени с дочкой`);
      const help = el('small', 'family-time-rule');
      context.value = entry?.context || 'kindergarten'; time.value = entry?.startTime || '';
      const updateRule = () => { const garden = context.value === 'kindergarten'; time.min = garden ? '17:00' : '06:00'; time.max = garden ? '22:00' : '16:59'; help.textContent = garden ? 'Начало с 17:00; блок 2 часа' : 'Начало до 17:00; блок 2 часа'; };
      context.addEventListener('change', updateRule); updateRule();
      const save = button('Сохранить 2 ч', 'button outline family-time-save', async () => {
        if (!time.value) { time.reportValidity(); return; }
        const mins = Number(time.value.slice(0, 2)) * 60 + Number(time.value.slice(3));
        if (context.value === 'kindergarten' ? mins < 1020 : mins >= 1020) { notify(context.value === 'kindergarten' ? 'Для режима «В садике» выберите время с 17:00.' : 'Для режима «Дома / болеет» выберите время раньше 17:00.'); return; }
        save.disabled = true;
        try {
          const latest = await api('family-time');
          const entries = latest.entries.filter(item => !(item.weekStart === selectedWeek && item.day === day));
          entries.push({ weekStart: selectedWeek, day, context: context.value, startTime: time.value, durationHours: 2 });
          await api('family-time', 'PUT', { revision: latest.revision, entries });
          familyEntries = entries; notify(`${name}: время с дочкой сохранено приватно.`); renderFamilyTime();
        } catch (error) { if (error.status === 401 || error.status === 403) expireSession(); notify(error.status === 409 ? 'План обновился в другой вкладке. Повторите сохранение.' : error.message); }
        finally { save.disabled = false; }
      });
      const summary = entry ? el('small', 'family-time-summary', `${entry.startTime}–${String((Number(entry.startTime.slice(0, 2)) * 60 + Number(entry.startTime.slice(3)) + 120) / 60 | 0).padStart(2, '0')}:${String((Number(entry.startTime.slice(0, 2)) * 60 + Number(entry.startTime.slice(3)) + 120) % 60).padStart(2, '0')} · 2 ч`) : el('small', 'family-time-summary', 'Время не задано');
      add(card, heading, context, time, help, summary, save); grid.append(card);
    });
  }
  function renderCheckpoints() {
    const list = $('#checkpointList'); list.replaceChildren();
    const items = [...state.checkpoints].sort((a, b) => Number(a.done) - Number(b.done) || (a.due || '9999').localeCompare(b.due || '9999'));
    if (!items.length) list.append(el('p', 'empty', 'Добавьте контрольную точку для первой цели.'));
    for (const item of items) {
      const overdue = item.due && item.due < today() && !item.done;
      const pointState = item.done ? indicators.statusMeta.complete : overdue ? indicators.statusMeta.missing : indicators.statusMeta.neutral;
      const row = el('article', `checkpoint ${item.done ? 'completed' : ''} ${overdue ? 'checkpoint-overdue' : ''}`), check = el('input'); check.type = 'checkbox'; check.checked = item.done; check.dataset.edit = ''; check.setAttribute('aria-label', `Выполнено: ${item.title}`);
      check.addEventListener('change', async () => { const done = check.checked; await mutate(draft => { const cp = draft.checkpoints.find(c => c.id === item.id); cp.done = done; cp.completedAt = done ? new Date().toISOString() : null; }); });
      const content = el('div', 'checkpoint-body'); add(content, el('strong', '', item.title), el('span', '', `${goalName(item.goalId)}${item.criterion ? ` · ${item.criterion}` : ''}`));
      const right = el('div', 'checkpoint-right'); add(right, statusNode(pointState), el('time', overdue ? 'overload' : '', formatDate(item.due)), el('small', `status-text-${pointState.key}`, pointState.label), button('Изменить ↗', 'text-button', () => openCheckpoint(item.id)));
      add(row, check, content, right); list.append(row);
    }
  }
  function renderReviews() {
    const list = $('#reviewList'); list.replaceChildren();
    if (!state.reviews.length) list.append(el('p', 'empty', 'После первой проверки зафиксируйте факт и следующий шаг.'));
    for (const entry of [...state.reviews].sort((a, b) => b.at.localeCompare(a.at))) {
      const row = el('article', 'review-card'), content = el('div', 'review-content');
      add(content, el('span', 'area-chip', goalName(entry.goalId)), el('p', '', entry.observation), el('strong', '', entry.decision));
      if (entry.planCompletion != null) content.append(el('small', '', `Выполнено из плана: ${entry.planCompletion}%`));
      if (entry.nextReview) content.append(el('small', '', `Следующая проверка: ${formatDate(entry.nextReview)}`));
      add(row, el('time', 'review-date', formatDate(entry.at.slice(0, 10))), content, button('Изменить ↗', 'text-button', () => openReview(entry.id))); list.append(row);
    }
  }
  function render() { if (!state) { setControls(); return; } renderSummary(); renderFilters(); renderGoals(); renderTime(); renderCheckpoints(); renderReviews(); setControls(); globalThis.DashboardFinance?.render(); }
  function show(dialog) {
    const form = dialog.querySelector('form');
    if (form) { formError(form); form.dataset.baseRevision = String(revision); delete form.dataset.stale; if (['slotForm', 'capacityForm'].includes(form.id)) form.dataset.weekStart = selectedWeek; }
    if (!dialog.open) dialog.showModal(); setControls();
  }
  function canEdit() { if (authenticated && !saving) return true; if (!authenticated) openLogin(); return false; }
  function fillOptions(select, chosen) { select.replaceChildren(); for (const g of state.goals) { const option = el('option', '', `${g.area} · ${g.title}`); option.value = g.id; select.append(option); } if (chosen) select.value = chosen; }
  function openLogin() { $('#loginError').hidden = true; $('#loginForm').reset(); show($('#loginDialog')); }
  function openGoal(goalId) {
    const goal = state.goals.find(g => g.id === goalId);
    if (!authenticated) return openGoalDetail(goal);
    if (!canEdit()) return; const form = $('#goalForm'); form.reset();
    $('#goalDialogTitle').textContent = goal ? 'Изменить цель' : 'Новая цель';
    if (goal) for (const name of ['id', 'title', 'area', 'status', 'target', 'current', 'unit', 'deadline', 'weeklyHours', 'outcome', 'note']) form.elements[name].value = goal[name] ?? '';
    const managed = Boolean(goal && state.financeSummary?.goalId === goal.id);
    for (const name of ['current', 'unit']) { form.elements[name].readOnly = managed; form.elements[name].title = managed ? 'Значение ведёт финансовый журнал в разделе «Деньги».' : ''; }
    let managedNote = $('#managedFinanceGoalNote');
    if (!managedNote) { managedNote = el('p', 'form-note'); managedNote.id = 'managedFinanceGoalNote'; }
    if (!form.contains(managedNote)) form.querySelector('.form-error').before(managedNote);
    managedNote.hidden = !managed; managedNote.textContent = managed ? 'Эта финансовая цель управляется журналом «Деньги»: текущее значение и валюта меняются через поступления.' : '';
    show($('#goalDialog'));
  }
  function prepare(formId, items, itemId, goalId, fields) {
    if (!canEdit()) return false; if (!state.goals.length) { notify('Сначала добавьте цель'); return false; }
    const form = $(formId); form.reset(); fillOptions(form.elements.goalId, goalId);
    const item = items.find(i => i.id === itemId); form.dataset.editId = item?.id || '';
    if (item) for (const name of fields) form.elements[name].value = item[name] ?? '';
    show(form.closest('dialog')); return true;
  }
  function openCheckpoint(itemId, goalId) { if (prepare('#checkpointForm', state.checkpoints, itemId, goalId, ['goalId', 'title', 'due', 'criterion'])) $('#deleteCheckpoint').hidden = !itemId; }
  function openReview(itemId) { prepare('#reviewForm', state.reviews, itemId, null, ['goalId', 'observation', 'decision', 'planCompletion', 'nextReview']); }
  function openSlot(itemId, day = 'mon', goalId) {
    const schedule = selectedSchedule(), item = schedule.find(slot => slot.id === itemId);
    if (!authenticated) return openSlotDetail(item);
    if (!selectedStored()) { notify('Сначала создайте эту неделю, чтобы добавить или изменить блок.'); return; }
    if (!prepare('#slotForm', schedule, itemId, goalId, ['goalId', 'day', 'title', 'hours', 'actualHours'])) return;
    if (!itemId) { $('#slotForm').elements.day.value = day; $('#slotForm').elements.hours.value = 1; }
    syncActualHoursControls();
    $('#deleteSlot').hidden = !itemId; $('#slotDialogTitle').textContent = itemId ? 'Изменить блок' : 'Добавить блок';
  }
  function openDay(goalId, day) {
    const slots = selectedSchedule().filter(s => s.day === day && (!goalId || s.goalId === goalId));
    if (!authenticated) return openDayDetail(day, slots);
    if (!selectedStored()) { notify('Сначала создайте эту неделю, чтобы добавить или изменить блок.'); return; }
    if (slots.length <= 1) return openSlot(slots[0]?.id, day, goalId);
    let dialog = $('#dayDialog'); if (!dialog) { dialog = el('dialog', 'editor compact'); dialog.id = 'dayDialog'; document.body.append(dialog); }
    dialog.replaceChildren(); add(dialog, el('h2', '', weekdays[day]), el('p', '', goalId ? goalName(goalId) : formatDate(indicators.dateForSlot(selectedWeek, day))));
    for (const slot of slots) dialog.append(button(`${slot.title} · ${number(slot.hours)} ч ↗`, 'detail-row', () => { dialog.close(); openSlot(slot.id); }));
    add(dialog, button('+ Добавить блок', 'button dark', () => { dialog.close(); openSlot(null, day, goalId); }), button('Закрыть', 'text-button', () => dialog.close(), false)); show(dialog);
  }
  function detailDialog(title) {
    let dialog = $('#detailDialog');
    if (!dialog) { dialog = el('dialog', 'editor compact'); dialog.id = 'detailDialog'; document.body.append(dialog); }
    dialog.setAttribute('aria-label', title);
    dialog.replaceChildren(); add(dialog, el('h2', '', title)); return dialog;
  }
  function openSlotDetail(slot) {
    if (!slot) return notify('В этой ячейке пока нет блока.');
    const indicator = statusFor(slot), dialog = detailDialog(slot.title);
    add(dialog, el('p', '', `${weekdays[slot.day]} · ${formatDate(slotDate(slot))}`), el('p', `status-text-${indicator.key}`, `${indicator.icon} ${indicator.label}`), el('p', '', `План: ${number(slot.hours)} ч`), el('p', '', slot.actualHours == null ? 'Факт: пока не внесён' : `Факт: ${number(slot.actualHours)} ч`), button('Закрыть', 'text-button', () => dialog.close(), false)); show(dialog);
  }
  function openDayDetail(day, slots) {
    const dialog = detailDialog(`${weekdays[day]} · ${formatDate(indicators.dateForSlot(selectedWeek, day))}`);
    if (!slots.length) dialog.append(el('p', 'empty', 'На этот день блоков нет.'));
    slots.forEach(slot => { const indicator = statusFor(slot); const item = button('', `detail-row status-text-${indicator.key}`, () => { dialog.close(); openSlotDetail(slot); }, false); add(item, statusNode(indicator), el('strong', '', slot.title), el('small', '', `${number(slot.hours)} ч план · ${slot.actualHours == null ? 'факт —' : `${number(slot.actualHours)} ч факт`}`)); dialog.append(item); });
    dialog.append(button('Закрыть', 'text-button', () => dialog.close(), false)); show(dialog);
  }
  function openGoalDetail(goal) {
    if (!goal) return;
    const points = state.checkpoints.filter(point => point.goalId === goal.id), progress = goalProgress(goal, points), dialog = detailDialog(goal.title);
    add(dialog, el('p', '', goal.area), el('p', '', goal.outcome || 'Ожидаемый результат не указан.'), el('p', '', progress == null ? 'Движение к результату: факт ещё не внесён.' : `Движение к результату: ${Math.round(progress)}%`), el('p', '', `${points.filter(point => point.done).length}/${points.length} контрольных точек выполнено`), button('Закрыть', 'text-button', () => dialog.close(), false)); show(dialog);
  }
  const nullable = value => value === '' ? null : Number(value);
  function values(form) { return Object.fromEntries(new FormData(form)); }
  function requireText(form, fields) { if (fields.some(name => !form.elements[name].value.trim())) { formError(form, 'Заполните обязательные текстовые поля.'); return false; } return true; }
  $('#goalForm').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; if (!requireText(form, ['title', 'area'])) return; const v = values(form);
    const value = { title: v.title.trim(), area: v.area.trim(), status: v.status, target: nullable(v.target), current: nullable(v.current), unit: v.unit.trim(), deadline: v.deadline, weeklyHours: nullable(v.weeklyHours), outcome: v.outcome.trim(), note: v.note.trim() };
    if (await mutate(draft => { const existing = draft.goals.find(g => g.id === v.id); if (existing) Object.assign(existing, value); else draft.goals.push({ id: uid(), ...value }); }, form)) $('#goalDialog').close();
  });
  $('#checkpointForm').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; if (!requireText(form, ['title'])) return; const v = values(form), editId = form.dataset.editId;
    const value = { goalId: v.goalId, title: v.title.trim(), due: v.due, criterion: v.criterion.trim() };
    if (await mutate(draft => { const item = draft.checkpoints.find(c => c.id === editId); if (item) Object.assign(item, value); else draft.checkpoints.push({ id: uid(), done: false, completedAt: null, ...value }); }, form)) $('#checkpointDialog').close();
  });
  $('#slotForm').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; if (!requireText(form, ['title'])) return; const v = values(form), editId = form.dataset.editId;
    const value = { day: v.day, goalId: v.goalId, title: v.title.trim(), hours: Number(v.hours), actualHours: nullable(v.actualHours) };
    if (await mutate(draft => updateSelectedWeek(draft, week => { const item = week.schedule.find(s => s.id === editId); if (item) Object.assign(item, value); else week.schedule.push({ id: uid(), ...value }); }), form)) $('#slotDialog').close();
  });
  function syncActualHoursControls(source) {
    const form = $('#slotForm'), actual = form.elements.actualHours, slider = form.elements.actualHoursRange, planned = Number(form.elements.hours.value) || 0;
    slider.max = '24'; actual.max = '24';
    if (source === 'slider') actual.value = slider.value;
    else if (actual.value !== '' && Number.isFinite(Number(actual.value))) slider.value = String(Math.min(24, Math.max(0, Number(actual.value))));
    else slider.value = '0';
    const hint = $('#actualHoursHint');
    hint.textContent = actual.value === '' ? 'Нет отметки: введите 0, если факт равен нулю.' : `Факт: ${number(actual.value)} ч. Ползунок и число синхронизированы.`;
    const preview = $('#actualPreview'), dial = $('#actualDial'), status = indicators.slotStatus({ hours: planned, actualHours: nullable(actual.value) }, slotDate({ day: form.elements.day.value }), today()), progress = actual.value === '' ? null : Math.min(100, Number(actual.value) / Math.max(planned, 0.01) * 100);
    if (dial) { dial.replaceChildren(ring(progress, actual.value === '' ? 'Факт ещё не внесён' : `Факт ${number(actual.value)} из ${number(planned)} часов`, 'hours-ring actual-preview-ring', status)); }
    if (preview) preview.textContent = `${status.icon} ${status.label}${actual.value === '' ? ': факт пока не внесён.' : `: ${number(actual.value)} из ${number(planned)} ч.`}`;
  }
  $('#slotForm').elements.actualHours.addEventListener('input', () => syncActualHoursControls('number'));
  $('#slotForm').elements.actualHoursRange.addEventListener('input', () => syncActualHoursControls('slider'));
  $('#slotForm').elements.hours.addEventListener('input', () => syncActualHoursControls('number'));
  $('#slotForm').elements.day.addEventListener('change', () => syncActualHoursControls('number'));
  $('#actualZero')?.addEventListener('click', () => { $('#slotForm').elements.actualHours.value = '0'; syncActualHoursControls('number'); });
  $('#actualPlanned')?.addEventListener('click', () => { $('#slotForm').elements.actualHours.value = $('#slotForm').elements.hours.value || '0'; syncActualHoursControls('number'); });
  $('#actualClear')?.addEventListener('click', () => { $('#slotForm').elements.actualHours.value = ''; syncActualHoursControls('number'); });
  $('#reviewForm').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; if (!requireText(form, ['observation', 'decision'])) return; const v = values(form), editId = form.dataset.editId;
    const value = { goalId: v.goalId, observation: v.observation.trim(), decision: v.decision.trim(), planCompletion: nullable(v.planCompletion), nextReview: v.nextReview };
    if (await mutate(draft => { const item = draft.reviews.find(r => r.id === editId); if (item) Object.assign(item, value, { updatedAt: new Date().toISOString() }); else draft.reviews.push({ id: uid(), at: new Date().toISOString(), ...value }); }, form)) $('#reviewDialog').close();
  });
  $('#deleteCheckpoint').addEventListener('click', async () => { const form = $('#checkpointForm'), itemId = form.dataset.editId; if (itemId && confirm('Удалить эту запись?')) { if (await mutate(draft => { draft.checkpoints = draft.checkpoints.filter(item => item.id !== itemId); }, form)) form.closest('dialog').close(); } });
  $('#deleteSlot').addEventListener('click', async () => { const form = $('#slotForm'), itemId = form.dataset.editId; if (itemId && confirm('Удалить эту запись?')) { if (await mutate(draft => updateSelectedWeek(draft, week => { week.schedule = week.schedule.filter(item => item.id !== itemId); }), form)) form.closest('dialog').close(); } });
  function switchWeek(value) { if (!value || !state || saving) return; selectedWeek = monday(value); render(); }
  async function createSelectedWeek() {
    if (!canEdit() || selectedStored()) return;
    if (!confirm(`Создать ${formatDate(selectedWeek)}? План будет скопирован из основной недели, а фактические часы очищены.`)) return;
    await mutate(draft => {
      if ((draft.weekHistory || []).some(week => week.weekStart === selectedWeek) || draft.weekStart === selectedWeek) return;
      draft.weekHistory = [...(draft.weekHistory || []), { weekStart: selectedWeek, capacity: draft.capacity, schedule: clone(draft.schedule).map(slot => ({ ...slot, id: uid(), actualHours: null })) }];
    });
  }
  $('#previousWeek').addEventListener('click', () => switchWeek(dateShift(selectedWeek, -7)));
  $('#nextWeek').addEventListener('click', () => switchWeek(dateShift(selectedWeek, 7)));
  $('#weekStart').addEventListener('change', event => switchWeek(event.target.value));
  $('#currentWeek')?.addEventListener('click', () => switchWeek(monday(today())));
  $('#createWeek')?.addEventListener('click', createSelectedWeek);
  $('#editCapacity').addEventListener('click', () => { if (!selectedStored()) return notify('Сначала создайте эту неделю.'); if (canEdit()) { $('#capacityForm').elements.capacity.value = selectedCapacity(); show($('#capacityDialog')); } });
  $('#capacityForm').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget, capacity = Number(form.elements.capacity.value); if (await mutate(draft => updateSelectedWeek(draft, week => { week.capacity = capacity; }), form)) $('#capacityDialog').close(); });
  $('#loginForm').addEventListener('submit', async event => {
    event.preventDefault(); $('#loginSubmit').disabled = true; $('#loginError').hidden = true;
    try {
      const result = await api('login', 'POST', { password: $('#loginPassword').value }); authenticated = true; csrfToken = result.csrfToken; sessionToken = result.sessionToken || ''; authEpoch++;
      $('#loginPassword').value = ''; await loadState(); await Promise.all([globalThis.DashboardFinance?.load(), loadFamilyTime()]); $('#loginDialog').close(); $('#connectionError').hidden = true;
    } catch (error) { $('#loginError').textContent = error.status === 401 ? 'Пароль не подошёл. Попробуйте ещё раз.' : error.message; $('#loginError').hidden = false; }
    finally { $('#loginSubmit').disabled = false; setControls(); }
  });
  $('#authButton').addEventListener('click', async () => {
    if (!authenticated) return openLogin();
    try { await api('logout', 'POST', {}); authenticated = false; csrfToken = ''; sessionToken = ''; authEpoch++; familyEntries = []; globalThis.DashboardFinance?.clear(); renderFamilyTime(); setControls(); notify('Редактирование заблокировано'); }
    catch (error) { notify(error.message); }
  });
  $('#openLogin').addEventListener('click', openLogin);
  $('#openHelp').addEventListener('click', () => show($('#helpDialog')));
  for (const selector of ['#addGoalTop', '#addGoal']) $(selector).addEventListener('click', () => openGoal());
  $('#addCheckpoint').addEventListener('click', () => openCheckpoint()); $('#addSlot').addEventListener('click', () => openSlot());
  for (const selector of ['#addReviewTop', '#addReview']) $(selector).addEventListener('click', () => openReview());
  for (const selector of ['#areaFilter', '#statusFilter']) $(selector).addEventListener('change', renderGoals);
  $('#goalSearch')?.addEventListener('input', renderGoals);
  $('#openHelpInline')?.addEventListener('click', () => show($('#helpDialog')));
  document.querySelectorAll('[data-close]').forEach(node => node.addEventListener('click', () => { if (!saving) $(`#${node.dataset.close}`).close(); }));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); }));
  $('#exportButton').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }), link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = `moy-kurs-${today()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  $('#importInput').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file || !canEdit()) return;
    try {
      if (file.size > 900000) throw new Error('Файл больше 900 КБ.');
      const data = JSON.parse(await file.text());
      if (![1, 2].includes(data.version) || !['goals', 'schedule', 'reviews', 'checkpoints'].every(k => Array.isArray(data[k]))) throw new Error('Формат копии не распознан.');
      if (data.version === 1) { data.version = 2; data.weekStart = monday(today()); data.capacity = 25; data.weekHistory = []; data.schedule.forEach(s => { s.actualHours = null; }); }
      if (!confirm('Импорт заменит весь план на сервере, включая историю недель. Скачайте текущую копию перед заменой. Продолжить?')) return;
      await mutate(draft => { for (const key of Object.keys(draft)) delete draft[key]; Object.assign(draft, data); });
    } catch (error) { notify(`Импорт не выполнен: ${error.message}`); }
    finally { event.target.value = ''; }
  });
  async function refreshPlan() {
    if (document.querySelector('.editor:not(.login-dialog)[open] form:not([data-stale="true"])')) return notify('Сначала закройте открытую форму, чтобы не потерять введённый текст.');
    if (saving) return;
    try { await loadState(); notify('План обновлён'); }
    catch (error) { $('#saveStatus').textContent = 'Обновление не удалось'; $('.sync-dot')?.setAttribute('data-state', 'error'); notify(error.message); }
  }
  $('#refreshButton')?.addEventListener('click', refreshPlan);
  async function init() {
    globalThis.DashboardFinance?.init({
      api, state: () => state, revision: () => revision, authenticated: () => authenticated, authEpoch: () => authEpoch, today,
      refreshPublic: loadState, beginSave, endSave, expireSession,
      openLogin, setState: (nextState, nextRevision) => { if (nextRevision >= revision) { state = nextState; revision = nextRevision; render(); } },
    });
    // Public reading must remain available even when session lookup is slow or fails.
    api('session').then(session => {
      if (!authenticated && session.authenticated) { authenticated = true; csrfToken = session.csrfToken || ''; sessionToken = session.sessionToken || ''; authEpoch++; globalThis.DashboardFinance?.load(); loadFamilyTime(); renderFamilyTime(); }
      setControls();
    }).catch(() => {});
    try { await loadState(); }
    catch (error) { $('#connectionError').textContent = error.message; $('#connectionError').hidden = false; }
  }
  function markActiveSection() {
    const target = location.hash || '#overview';
    document.querySelectorAll('.site-header nav a').forEach(link => { if (link.getAttribute('href') === target) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current'); });
  }
  window.addEventListener('hashchange', markActiveSection);
  markActiveSection();
  let renderedDate = today();
  function refreshDate() {
    const currentDate = today();
    if (state && currentDate !== renderedDate) { renderedDate = currentDate; render(); }
  }
  setInterval(refreshDate, 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDate(); });
  init();
})();
