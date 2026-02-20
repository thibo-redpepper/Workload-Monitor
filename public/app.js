const contactSelect = document.getElementById("contactSelect");
const dayInput = document.getElementById("dayInput");
const capacityInput = document.getElementById("capacityInput");
const loadButton = document.getElementById("loadButton");
const workloadStrip = document.getElementById("workloadStrip");
const weekPreview = document.getElementById("weekPreview");
const overbookedAlert = document.getElementById("overbookedAlert");
const overbookedText = document.getElementById("overbookedText");
const alertRescheduleBtn = document.getElementById("alertRescheduleBtn");
const alertRebalanceBtn = document.getElementById("alertRebalanceBtn");
const taskWorkspace = document.getElementById("taskWorkspace");
const todayList = document.getElementById("todayList");
const upcomingList = document.getElementById("upcomingList");
const overdueList = document.getElementById("overdueList");
const backlogList = document.getElementById("backlogList");
const statusText = document.getElementById("statusText");
const actionLogList = document.getElementById("actionLogList");
const refreshLogBtn = document.getElementById("refreshLogBtn");
const taskItemTemplate = document.getElementById("taskItemTemplate");

const bulkBar = document.getElementById("bulkBar");
const selectionText = document.getElementById("selectionText");
const markPrioBtn = document.getElementById("markPrioBtn");
const openPlannerBtn = document.getElementById("openPlannerBtn");
const markRemoveBtn = document.getElementById("markRemoveBtn");
const clearLabelBtn = document.getElementById("clearLabelBtn");
const deleteBtn = document.getElementById("deleteBtn");
const clearSelectionBtn = document.getElementById("clearSelectionBtn");

const plannerModal = document.getElementById("plannerModal");
const closePlannerBtn = document.getElementById("closePlannerBtn");
const plannerSummary = document.getElementById("plannerSummary");
const plannerSuggestions = document.getElementById("plannerSuggestions");
const plannerGrid = document.getElementById("plannerGrid");
const applyPushWeekBtn = document.getElementById("applyPushWeekBtn");
const applyPlanBtn = document.getElementById("applyPlanBtn");

const LABELS = {
  prio: "Echt Prio",
  remove: "Niet Nodig",
};
const WRITABLE_LABELS = new Set(["prio", "remove"]);

const state = {
  tasksById: new Map(),
  selectedTaskIds: new Set(),
  labelsByTaskId: new Map(),
  buckets: {
    dueToday: [],
    upcomingWeek: [],
    overdue: [],
    backlog: [],
  },
  weekPreview: null,
  summary: null,
  planner: null,
  openMenuTaskId: null,
};

const urlParams = new URLSearchParams(window.location.search);
const preselectedContactId = urlParams.get("contactId");
const focusTaskId = urlParams.get("focusTaskId");

function todayString() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function fmtHours(value) {
  const hours = Number(value || 0);
  const minutes = Math.round(hours * 60);
  if (Math.abs(minutes) < 60) return `${minutes}m`;
  return `${hours.toFixed(1)}u`;
}

function parseDateUTC(dateString) {
  return new Date(`${dateString}T00:00:00Z`);
}

function weekdayShort(dateString) {
  const names = ["Zo", "Ma", "Di", "Wo", "Do", "Vr", "Za"];
  return names[parseDateUTC(dateString).getUTCDay()];
}

function dayMonthShort(dateString) {
  const d = parseDateUTC(dateString);
  const months = [
    "jan",
    "feb",
    "mrt",
    "apr",
    "mei",
    "jun",
    "jul",
    "aug",
    "sep",
    "okt",
    "nov",
    "dec",
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

function renderWeekPreview(preview) {
  if (!preview || !Array.isArray(preview.days) || preview.days.length === 0) {
    weekPreview.innerHTML = "";
    return;
  }

  const activeDate = dayInput.value;
  weekPreview.innerHTML = `
    <div class="week-preview-head">
      <div>
        <p class="week-preview-kicker">Komende werkweek</p>
        <h3>${dayMonthShort(preview.startDate)} – ${dayMonthShort(
    preview.endDate
  )} · W${preview.isoWeek}</h3>
      </div>
      <p class="week-preview-meta">
        ${fmtHours(preview.totalHours)} totaal · ${preview.overbookedDays} overboekte dag(en)
      </p>
    </div>
    <div class="week-preview-grid">
      ${preview.days
        .map((day) => {
          const statusClass = day.overbooked ? "is-overbooked" : "is-fit";
          const freeHours = Math.max(
            0,
            Number(preview.capacityHours || 0) - Number(day.hours || 0)
          );
          const statusText = day.overbooked
            ? `+${fmtHours(day.overloadHours)} over`
            : `${fmtHours(freeHours)} vrij`;
          return `
            <button
              type="button"
              class="week-day-card ${statusClass} ${
            day.date === activeDate ? "is-active" : ""
          }"
              data-date="${day.date}"
              aria-label="Laad workload voor ${day.date}"
            >
              <p class="week-day-label">${weekdayShort(day.date)} ${parseDateUTC(
            day.date
          ).getUTCDate()}</p>
              <strong>${fmtHours(day.hours)}</strong>
              <span>${day.taskCount} taken · ${statusText}</span>
            </button>
          `;
        })
        .join("")}
    </div>
  `;
}

function importanceScore(task) {
  const value = String(task?.importance || "Normal").toLowerCase();
  if (value === "highest") return 4;
  if (value === "high") return 3;
  if (value === "normal") return 2;
  return 1;
}

function selectedIds() {
  return [...state.selectedTaskIds];
}

function selectedHours() {
  return selectedIds().reduce((sum, id) => {
    const task = state.tasksById.get(id);
    return sum + Number(task?.effortHours || 0);
  }, 0);
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function loadLocalLabels() {
  const raw = localStorage.getItem("capacityhub_labels");
  const obj = safeJsonParse(raw || "{}", {});
  state.labelsByTaskId = new Map(Object.entries(obj));
}

function persistLocalLabels() {
  const obj = {};
  for (const [taskId, label] of state.labelsByTaskId.entries()) {
    obj[taskId] = label;
  }
  localStorage.setItem("capacityhub_labels", JSON.stringify(obj));
}

function setStatus(message) {
  statusText.textContent = message;
}

function setBusy(isBusy) {
  loadButton.disabled = isBusy;
  loadButton.textContent = isBusy ? "Laden..." : "Laad workload";
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.message || "API fout");
  }
  return payload;
}

function renderEmpty(container, text) {
  container.innerHTML = "";
  const el = document.createElement("div");
  el.className = "empty-state";
  el.textContent = text;
  container.appendChild(el);
}

function computeOverbookAmount() {
  if (!state.summary) return 0;
  return Math.max(0, state.summary.dueTodayHours - state.summary.capacityHours);
}

function getOverbookCandidates() {
  const overload = computeOverbookAmount();
  if (overload <= 0) return [];
  const source = [...(state.buckets.dueToday || [])];
  source.sort((a, b) => {
    const rankDiff = importanceScore(a) - importanceScore(b);
    if (rankDiff !== 0) return rankDiff;
    return Number(b.effortHours || 0) - Number(a.effortHours || 0);
  });
  const picked = [];
  let sum = 0;
  for (const task of source) {
    picked.push(task);
    sum += Number(task.effortHours || 0);
    if (sum >= overload) break;
  }
  return picked;
}

function renderWorkloadStrip(summary) {
  const overload = Math.max(0, summary.dueTodayHours - summary.capacityHours);
  const overbooked = overload > 0;

  workloadStrip.classList.toggle("is-overbooked", overbooked);
  workloadStrip.innerHTML = `
    <div class="today-kpi">
      <p>Vandaag</p>
      <strong class="today-value">${fmtHours(summary.dueTodayHours)}</strong>
      <span class="${overbooked ? "danger" : "ok"}">
        ${
          overbooked
            ? `Overboekt met ${fmtHours(overload)}`
            : `Binnen ${fmtHours(summary.capacityHours)} capaciteit`
        }
      </span>
    </div>
    <div class="strip-meta">
      <article><span>Week</span><strong>${fmtHours(summary.upcomingWeekHours)}</strong></article>
      <article><span>Backlog</span><strong>${fmtHours(
        summary.backlogHours
      )} · ${summary.backlogCount}</strong></article>
      <article><span>Overdue</span><strong>${fmtHours(
        summary.overdueHours
      )} · ${summary.overdueCount}</strong></article>
      <article><span>Focus</span><strong>${
        summary.dueTodayCount > 0 ? "Actie nodig" : "Rustig"
      }</strong></article>
    </div>
  `;

  const kpi = workloadStrip.querySelector(".today-value");
  kpi.classList.remove("kpi-bump");
  requestAnimationFrame(() => kpi.classList.add("kpi-bump"));
}

function renderOverbookAlert(summary) {
  const overload = Math.max(0, summary.dueTodayHours - summary.capacityHours);
  const overbooked = overload > 0;
  overbookedAlert.classList.toggle("hidden", !overbooked);
  taskWorkspace.classList.toggle("is-overbooked-zone", overbooked);
  if (overbooked) {
    overbookedText.textContent = `Je zit vandaag ${fmtHours(
      overload
    )} boven capaciteit.`;
  }
}

function refreshSelectionUi() {
  const count = state.selectedTaskIds.size;
  const hours = selectedHours();
  selectionText.textContent = `${count} tasks selected — ${fmtHours(hours)}`;
  bulkBar.classList.toggle("is-visible", count > 0);

  const disabled = count === 0;
  markPrioBtn.disabled = disabled;
  openPlannerBtn.disabled = disabled;
  markRemoveBtn.disabled = disabled;
  clearLabelBtn.disabled = disabled;
  deleteBtn.disabled = disabled;
  clearSelectionBtn.disabled = disabled;
}

function closeAllRowMenus() {
  state.openMenuTaskId = null;
  renderAllLists();
}

async function applyLabel(taskIds, labelKey) {
  if (!taskIds.length || !labelKey) return;

  const validIds = taskIds.filter((id) => state.tasksById.has(id));
  if (!validIds.length) return;

  let idsToPersistLocal = validIds;
  if (WRITABLE_LABELS.has(labelKey)) {
    setStatus(
      labelKey === "prio"
        ? "Prioriteit wordt gesynchroniseerd met Wrike..."
        : "Label wordt gesynchroniseerd met Wrike..."
    );
    const payload = await requestJson("/api/tasks/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskIds: validIds, labelKey }),
    });

    idsToPersistLocal = (payload.results || [])
      .filter((row) => row.ok)
      .map((row) => row.taskId);

    setStatus(
      `Wrike sync: ${payload.successCount} gelukt, ${payload.failedCount} gefaald.`
    );
    await loadWorkload({ preserveWeekPreview: true });
    await loadActionLog();
  }

  for (const id of idsToPersistLocal) {
    state.labelsByTaskId.set(id, labelKey);
  }
  persistLocalLabels();
  renderAllLists();
}

async function clearLabels(taskIds) {
  if (!taskIds.length) return;
  const validIds = taskIds.filter((id) => state.tasksById.has(id));
  if (!validIds.length) return;

  const labeledIds = validIds.filter((id) => {
    const label = state.labelsByTaskId.get(id);
    return label === "prio" || label === "remove";
  });

  if (!labeledIds.length) {
    setStatus("Geen lokaal label om te verwijderen.");
    return;
  }

  setStatus("Label wordt verwijderd in Wrike...");
  const payload = await requestJson("/api/tasks/labels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskIds: labeledIds, labelKey: "clear" }),
  });

  const successIds = new Set(
    (payload.results || []).filter((row) => row.ok).map((row) => row.taskId)
  );
  for (const id of successIds) state.labelsByTaskId.delete(id);
  persistLocalLabels();

  setStatus(
    `Label verwijderd: ${payload.successCount} gelukt, ${payload.failedCount} gefaald.`
  );
  await loadWorkload({ preserveWeekPreview: true });
  await loadActionLog();
  renderAllLists();
}

async function pushWeekAction(taskIds) {
  if (!taskIds.length) return;
  setStatus("Taken worden 1 week opgeschoven...");
  const payload = await requestJson("/api/tasks/push-week", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskIds, shiftDays: 7 }),
  });
  setStatus(
    `Push klaar: ${payload.successCount} gelukt, ${payload.failedCount} gefaald.`
  );
  await loadWorkload();
  await loadActionLog();
}

async function deleteAction(taskIds) {
  if (!taskIds.length) return;
  setStatus("Taken worden verwijderd...");
  const payload = await requestJson("/api/tasks/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskIds }),
  });
  setStatus(
    `Delete klaar: ${payload.successCount} gelukt, ${payload.failedCount} gefaald.`
  );
  await loadWorkload();
  await loadActionLog();
}

function createTaskNode(task, options = {}) {
  const node = taskItemTemplate.content.cloneNode(true);
  const row = node.querySelector(".task-row");
  const checkbox = node.querySelector(".task-select");
  const title = node.querySelector(".task-title");
  const meta = node.querySelector(".task-meta");
  const briefingToggle = node.querySelector(".briefing-toggle");
  const briefingBody = node.querySelector(".task-briefing");
  const labelChip = node.querySelector(".task-label");
  const hoursPill = node.querySelector(".hours-pill");
  const menuTrigger = node.querySelector(".menu-trigger");
  const menu = node.querySelector(".task-menu");

  const menuReschedule = node.querySelector(".reschedule-one");
  const menuPush = node.querySelector(".push-one");
  const menuPrio = node.querySelector(".mark-prio-one");
  const menuRemove = node.querySelector(".mark-remove-one");
  const menuClearLabel = node.querySelector(".clear-label-one");
  const menuDelete = node.querySelector(".delete-one");

  const selected = state.selectedTaskIds.has(task.id);
  checkbox.checked = selected;
  row.classList.toggle("is-selected", selected);
  if (options.overbookContributor) row.classList.add("overbook-contributor");

  checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.selectedTaskIds.add(task.id);
    else state.selectedTaskIds.delete(task.id);
    refreshSelectionUi();
    row.classList.toggle("is-selected", checkbox.checked);
  });

  title.textContent = task.title;
  title.href = task.permalink || "#";
  const due = task.due ? task.due.slice(0, 10) : "geen due date";
  meta.textContent = `${task.statusLabel || task.status} · ${task.importance} · ${due}`;

  const description = String(task.description || "").trim();
  if (description) {
    briefingToggle.classList.remove("hidden");
    briefingBody.textContent = description;
    briefingToggle.addEventListener("click", () => {
      const opening = briefingBody.classList.contains("hidden");
      briefingBody.classList.toggle("hidden", !opening);
      briefingToggle.textContent = opening ? "Verberg briefing" : "Toon briefing";
      row.classList.toggle("is-briefing-open", opening);
    });
  }

  hoursPill.textContent = fmtHours(task.effortHours);
  if (options.overbookContributor) hoursPill.classList.add("is-danger");

  const labelKey = state.labelsByTaskId.get(task.id);
  if (labelKey && LABELS[labelKey]) {
    labelChip.classList.remove("hidden");
    labelChip.classList.add(`label-${labelKey}`);
    labelChip.textContent = LABELS[labelKey];

    menuClearLabel.classList.remove("hidden");
    menuClearLabel.textContent =
      labelKey === "prio" ? "Verwijder Echt Prio" : "Verwijder Niet Nodig";
  } else {
    menuClearLabel.classList.add("hidden");
  }

  menu.classList.toggle("hidden", state.openMenuTaskId !== task.id);
  menuTrigger.addEventListener("click", (event) => {
    event.stopPropagation();
    state.openMenuTaskId = state.openMenuTaskId === task.id ? null : task.id;
    renderAllLists();
  });

  menuReschedule.addEventListener("click", async () => {
    state.selectedTaskIds.clear();
    state.selectedTaskIds.add(task.id);
    refreshSelectionUi();
    await openPlanningPopupForTaskIds([task.id]);
  });
  menuPush.addEventListener("click", async () => {
    const ok = window.confirm(`Taak "${task.title}" +1 week verplaatsen?`);
    if (!ok) return;
    await pushWeekAction([task.id]);
  });
  menuPrio.addEventListener("click", async () => {
    try {
      await applyLabel([task.id], "prio");
    } catch (error) {
      setStatus(`Mark priority fout: ${error.message}`);
    }
  });
  menuRemove.addEventListener("click", async () => {
    try {
      await applyLabel([task.id], "remove");
    } catch (error) {
      setStatus(`Mark not needed fout: ${error.message}`);
    }
  });
  menuClearLabel.addEventListener("click", async () => {
    try {
      await clearLabels([task.id]);
    } catch (error) {
      setStatus(`Label verwijderen fout: ${error.message}`);
    }
  });
  menuDelete.addEventListener("click", async () => {
    const ok = window.confirm(`Taak "${task.title}" verwijderen?`);
    if (!ok) return;
    await deleteAction([task.id]);
  });

  return node;
}

function renderTasks(container, tasks, options = {}) {
  container.innerHTML = "";
  if (!tasks.length) {
    renderEmpty(container, "Geen taken in deze categorie.");
    return;
  }
  const highlightIds = options.highlightIds || new Set();
  const fragment = document.createDocumentFragment();
  for (const task of tasks) {
    fragment.appendChild(
      createTaskNode(task, { overbookContributor: highlightIds.has(task.id) })
    );
  }
  container.appendChild(fragment);
}

function updateStateTasks(buckets) {
  state.buckets = buckets;
  state.tasksById.clear();
  const all = [
    ...buckets.dueToday,
    ...buckets.upcomingWeek,
    ...buckets.overdue,
    ...buckets.backlog,
  ];
  for (const task of all) state.tasksById.set(task.id, task);

  const validIds = new Set(all.map((t) => t.id));
  for (const id of [...state.selectedTaskIds]) {
    if (!validIds.has(id)) state.selectedTaskIds.delete(id);
  }
}

function renderAllLists() {
  const overbookCandidateIds = new Set(getOverbookCandidates().map((t) => t.id));
  renderTasks(todayList, state.buckets.dueToday || [], {
    highlightIds: overbookCandidateIds,
  });
  renderTasks(upcomingList, state.buckets.upcomingWeek || []);
  renderTasks(overdueList, state.buckets.overdue || []);
  renderTasks(backlogList, state.buckets.backlog || []);
  refreshSelectionUi();
}

async function loadContacts() {
  const payload = await requestJson("/api/contacts");
  const rows = payload.data || [];
  contactSelect.innerHTML = rows
    .map(
      (c) =>
        `<option value="${c.id}" ${c.me ? "selected" : ""}>${c.fullName} (${c.id})</option>`
    )
    .join("");
}

async function loadWorkload(options = {}) {
  const contactId = contactSelect.value;
  const date = dayInput.value;
  const capacity = capacityInput.value || "7";
  if (!contactId || !date) return;

  setBusy(true);
  setStatus("Workload aan het ophalen...");
  state.openMenuTaskId = null;
  const previousWeekPreview = state.weekPreview;
  try {
    const query = new URLSearchParams({ contactId, date, capacity });
    const payload = await requestJson(`/api/workload?${query.toString()}`);
    state.summary = payload.summary || null;
    const keepCurrentWeek =
      options.preserveWeekPreview &&
      previousWeekPreview &&
      Array.isArray(previousWeekPreview.days) &&
      previousWeekPreview.days.some((day) => day.date === date);
    state.weekPreview = keepCurrentWeek
      ? previousWeekPreview
      : payload.weekPreview || null;
    updateStateTasks(payload.buckets || {});
    renderWorkloadStrip(state.summary);
    renderWeekPreview(state.weekPreview);
    renderOverbookAlert(state.summary);
    renderAllLists();

    const selectedName =
      contactSelect.options[contactSelect.selectedIndex]?.textContent || contactId;
    setStatus(`${selectedName} • ${date}`);
  } catch (error) {
    workloadStrip.innerHTML = "";
    weekPreview.innerHTML = "";
    renderEmpty(todayList, `Fout: ${error.message}`);
    renderEmpty(upcomingList, "Kon geen weektaken laden.");
    renderEmpty(overdueList, "Kon geen overdue laden.");
    renderEmpty(backlogList, "Kon geen backlog laden.");
    setStatus("Fout bij ophalen van workload.");
  } finally {
    setBusy(false);
  }
}

async function loadActionLog() {
  try {
    const payload = await requestJson("/api/action-log");
    const rows = payload.data || [];
    actionLogList.innerHTML = "";
    if (!rows.length) {
      renderEmpty(actionLogList, "Nog geen acties uitgevoerd.");
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      const el = document.createElement("article");
      el.className = "log-item";
      const time = new Date(row.at).toLocaleString();
      const detailParts = [];
      if (row.title) detailParts.push(row.title);
      if (row.fromDue || row.toDue) {
        detailParts.push(`${row.fromDue || "-"} -> ${row.toDue || "-"}`);
      }
      el.innerHTML = `<strong>${time} · ${row.action}</strong><p>${detailParts.join(
        " · "
      )}</p>`;
      fragment.appendChild(el);
    }
    actionLogList.appendChild(fragment);
  } catch (error) {
    renderEmpty(actionLogList, `Kon log niet laden: ${error.message}`);
  }
}

function closePlanner() {
  plannerModal.classList.add("hidden");
  state.planner = null;
}

function openPlanner() {
  plannerModal.classList.remove("hidden");
}

function renderPlanner(payload) {
  state.planner = {
    chosenDate: payload.suggestions?.[0]?.date || payload.days?.[0]?.date || "",
    days: payload.days || [],
    selectedTaskCount: payload.summary?.selectedTaskCount || 0,
    selectedHours: payload.summary?.selectedHours || 0,
    taskIds: payload.selectedTasks?.map((t) => t.id) || selectedIds(),
  };

  plannerSummary.textContent = `${state.planner.selectedTaskCount} taken (${fmtHours(
    state.planner.selectedHours
  )}) geselecteerd. Kies een dag of gebruik +1 week.`;

  plannerSuggestions.innerHTML = "";
  const suggestions = payload.suggestions || [];
  if (!suggestions.length) {
    const no = document.createElement("span");
    no.className = "suggestion warn";
    no.textContent = "Geen dag met vrije capaciteit gevonden in de komende 2 weken.";
    plannerSuggestions.appendChild(no);
  } else {
    for (const s of suggestions) {
      const el = document.createElement("button");
      el.className = "suggestion";
      el.textContent = `${s.date} • vrij na move: ${fmtHours(s.freeHoursAfter)}`;
      el.addEventListener("click", () => {
        state.planner.chosenDate = s.date;
        renderPlannerDays();
      });
      plannerSuggestions.appendChild(el);
    }
  }

  renderPlannerDays();
  openPlanner();
}

function renderPlannerDays() {
  plannerGrid.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const day of state.planner.days) {
    const row = document.createElement("label");
    row.className = `planner-row ${day.fits ? "fit" : "full"}`;

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "planner-date";
    radio.value = day.date;
    radio.checked = day.date === state.planner.chosenDate;
    radio.addEventListener("change", () => {
      state.planner.chosenDate = day.date;
    });

    const content = document.createElement("div");
    content.className = "planner-row-content";
    const status = day.fits ? "Past binnen capaciteit" : "Overboekt";
    content.innerHTML = `
      <strong>${day.date}</strong>
      <span>${fmtHours(day.scheduledHours)} gepland · na move ${fmtHours(
      day.afterMoveHours
    )} · ${status}</span>
    `;
    row.appendChild(radio);
    row.appendChild(content);
    fragment.appendChild(row);
  }
  plannerGrid.appendChild(fragment);
}

async function openPlanningPopupForTaskIds(ids) {
  if (!ids.length) return;
  const contactId = contactSelect.value;
  const fromDate = dayInput.value;
  const capacity = capacityInput.value || "7";
  setStatus("Planning-opties aan het berekenen...");
  const query = new URLSearchParams({
    contactId,
    fromDate,
    capacity,
    taskIds: ids.join(","),
  });
  const payload = await requestJson(`/api/planning-options?${query.toString()}`);
  renderPlanner(payload);
  setStatus("Planning popup geladen.");
}

async function openPlanningPopup() {
  return openPlanningPopupForTaskIds(selectedIds());
}

async function applyPlannerSelection() {
  const ids = state.planner?.taskIds || selectedIds();
  const targetDate = state.planner?.chosenDate;
  if (!ids.length || !targetDate) return;

  setStatus(`Taken worden ingepland op ${targetDate}...`);
  const payload = await requestJson("/api/tasks/schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskIds: ids, targetDate }),
  });
  closePlanner();
  setStatus(
    `Planning toegepast: ${payload.successCount} gelukt, ${payload.failedCount} gefaald.`
  );
  await loadWorkload();
  await loadActionLog();
}

async function applyPlannerPlusWeek() {
  const ids = state.planner?.taskIds || selectedIds();
  if (!ids.length) return;
  const ok = window.confirm(`${ids.length} geselecteerde taken +1 week verplaatsen?`);
  if (!ok) return;
  await pushWeekAction(ids);
  closePlanner();
}

async function handleDeleteSelected() {
  const ids = selectedIds();
  if (!ids.length) return;
  const ok = window.confirm(`${ids.length} taken verwijderen?`);
  if (!ok) return;
  await deleteAction(ids);
}

async function handleAlertReschedule() {
  const candidates = getOverbookCandidates().map((t) => t.id);
  if (!candidates.length) return;
  state.selectedTaskIds = new Set(candidates);
  renderAllLists();
  await openPlanningPopupForTaskIds(candidates);
}

async function handleAlertRebalance() {
  const ids = (state.buckets.dueToday || []).map((t) => t.id);
  if (!ids.length) return;
  state.selectedTaskIds = new Set(ids);
  renderAllLists();
  await openPlanningPopupForTaskIds(ids);
}

async function init() {
  dayInput.value = todayString();
  loadLocalLabels();
  refreshSelectionUi();

  try {
    await loadContacts();
    if (
      preselectedContactId &&
      contactSelect.querySelector(`option[value="${preselectedContactId}"]`)
    ) {
      contactSelect.value = preselectedContactId;
    }
    await loadWorkload();
    if (focusTaskId && state.tasksById.has(focusTaskId)) {
      state.selectedTaskIds.add(focusTaskId);
      renderAllLists();
      const focused = state.tasksById.get(focusTaskId);
      setStatus(`Taak geselecteerd vanuit management: ${focused.title}`);
    }
    await loadActionLog();
  } catch (error) {
    setStatus(`Kon niet initialiseren: ${error.message}`);
  }
}

loadButton.addEventListener("click", () => loadWorkload());
contactSelect.addEventListener("change", () => loadWorkload());
dayInput.addEventListener("change", () => loadWorkload());
capacityInput.addEventListener("change", () => loadWorkload());

markPrioBtn.addEventListener("click", async () => {
  try {
    await applyLabel(selectedIds(), "prio");
  } catch (error) {
    setStatus(`Mark priority fout: ${error.message}`);
  }
});
markRemoveBtn.addEventListener("click", async () => {
  try {
    await applyLabel(selectedIds(), "remove");
  } catch (error) {
    setStatus(`Mark not needed fout: ${error.message}`);
  }
});
clearLabelBtn.addEventListener("click", async () => {
  try {
    await clearLabels(selectedIds());
  } catch (error) {
    setStatus(`Label verwijderen fout: ${error.message}`);
  }
});
openPlannerBtn.addEventListener("click", async () => {
  try {
    await openPlanningPopup();
  } catch (error) {
    setStatus(`Herplannen fout: ${error.message}`);
  }
});
deleteBtn.addEventListener("click", async () => {
  try {
    await handleDeleteSelected();
  } catch (error) {
    setStatus(`Delete fout: ${error.message}`);
  }
});
clearSelectionBtn.addEventListener("click", () => {
  state.selectedTaskIds.clear();
  renderAllLists();
});

alertRescheduleBtn.addEventListener("click", () => handleAlertReschedule());
alertRebalanceBtn.addEventListener("click", () => handleAlertRebalance());
refreshLogBtn.addEventListener("click", () => loadActionLog());
weekPreview.addEventListener("click", async (event) => {
  const dayCard = event.target.closest(".week-day-card");
  if (!dayCard) return;
  const targetDate = dayCard.dataset.date;
  if (!targetDate || targetDate === dayInput.value) return;
  dayInput.value = targetDate;
  await loadWorkload({ preserveWeekPreview: true });
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".task-end") && state.openMenuTaskId !== null) {
    state.openMenuTaskId = null;
    renderAllLists();
  }
});

closePlannerBtn.addEventListener("click", closePlanner);
plannerModal.addEventListener("click", (event) => {
  if (event.target === plannerModal) closePlanner();
});
applyPlanBtn.addEventListener("click", () => applyPlannerSelection());
applyPushWeekBtn.addEventListener("click", () => applyPlannerPlusWeek());

init();
