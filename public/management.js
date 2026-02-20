const managementDateInput = document.getElementById("managementDateInput");
const managementCapacityInput = document.getElementById("managementCapacityInput");
const loadManagementBtn = document.getElementById("loadManagementBtn");
const managementTeams = document.getElementById("managementTeams");
const managementProfiles = document.getElementById("managementProfiles");
const managementRecommendations = document.getElementById(
  "managementRecommendations"
);
const replanModal = document.getElementById("replanModal");
const replanTaskTitle = document.getElementById("replanTaskTitle");
const replanActionInput = document.getElementById("replanActionInput");
const replanReasonField = document.getElementById("replanReasonField");
const replanReasonPresetInput = document.getElementById("replanReasonPresetInput");
const replanReasonInput = document.getElementById("replanReasonInput");
const replanErrorText = document.getElementById("replanErrorText");
const applyReplanBtn = document.getElementById("applyReplanBtn");
const closeReplanBtn = document.getElementById("closeReplanBtn");

const replanState = {
  taskId: "",
  taskTitle: "",
};

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

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderEmpty(container, text) {
  container.innerHTML = "";
  const el = document.createElement("div");
  el.className = "empty-state";
  el.textContent = text;
  container.appendChild(el);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.message || "API fout");
  }
  return payload;
}

function setStatus(message) {
  // Status line intentionally removed from management UI.
}

function decisionRank(decisionType) {
  if (decisionType === "keep_today") return 0;
  if (decisionType === "reschedule") return 1;
  return 2;
}

function isPrioStatusLabel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized.includes("prio");
}

function renderWrikePrioBadge(statusLabelRaw) {
  if (!isPrioStatusLabel(statusLabelRaw)) return "";
  return `<span class="decision-chip decision-keep">${escapeHtml(
    statusLabelRaw
  )}</span>`;
}

async function markTaskPriority(taskId) {
  setStatus("Prioriteit wordt aangepast in Wrike...");
  const payload = await requestJson("/api/tasks/labels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskIds: [taskId], labelKey: "prio" }),
  });
  setStatus(
    `Prio sync: ${payload.successCount} gelukt, ${payload.failedCount} gefaald.`
  );
}

async function pushTaskOneWeek(taskId) {
  setStatus("Taak wordt 1 week verplaatst...");
  const payload = await requestJson("/api/tasks/push-week", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskIds: [taskId], shiftDays: 7 }),
  });
  setStatus(
    `Verplaatsen: ${payload.successCount} gelukt, ${payload.failedCount} gefaald.`
  );
}

async function cancelTask(taskId, reason) {
  setStatus("Taak wordt geannuleerd in Wrike...");
  const payload = await requestJson("/api/tasks/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskIds: [taskId], reason }),
  });
  setStatus(
    `Annuleren: ${payload.successCount} gelukt, ${payload.failedCount} gefaald.`
  );
}

function setReplanError(message) {
  if (!replanErrorText) return;
  const clean = String(message || "").trim();
  replanErrorText.textContent = clean;
  replanErrorText.classList.toggle("hidden", !clean);
}

function syncReplanReasonVisibility() {
  if (!replanActionInput || !replanReasonField || !replanReasonInput) return;
  const isCancel = replanActionInput.value === "cancel";
  replanReasonField.classList.toggle("hidden", !isCancel);
  const needsCustomText = isCancel && replanReasonPresetInput?.value === "custom";
  replanReasonInput.required = Boolean(needsCustomText);
}

function closeReplanModal() {
  if (!replanModal) return;
  replanModal.classList.add("hidden");
  replanState.taskId = "";
  replanState.taskTitle = "";
}

function openReplanModal(taskId, taskTitle) {
  if (!replanModal || !replanActionInput || !replanTaskTitle || !replanReasonInput) {
    return;
  }
  replanState.taskId = String(taskId || "");
  replanState.taskTitle = String(taskTitle || "");
  replanTaskTitle.textContent = replanState.taskTitle || "Geselecteerde taak";
  replanActionInput.value = "must_this_week";
  if (replanReasonPresetInput) replanReasonPresetInput.value = "Niet meer nodig";
  replanReasonInput.value = "";
  setReplanError("");
  syncReplanReasonVisibility();
  replanModal.classList.remove("hidden");
}

function buildCancelReason() {
  const presetValue = String(replanReasonPresetInput?.value || "").trim();
  const customText = String(replanReasonInput?.value || "").trim();

  if (presetValue === "custom") {
    if (!customText) return "";
    return customText;
  }

  if (!presetValue && !customText) return "";
  if (presetValue && customText) return `${presetValue}: ${customText}`;
  return presetValue || customText;
}

async function applyReplanAction() {
  const taskId = replanState.taskId;
  if (!taskId || !replanActionInput) return;
  const action = replanActionInput.value;

  applyReplanBtn.disabled = true;
  setReplanError("");
  try {
    if (action === "must_this_week") {
      await markTaskPriority(taskId);
    } else if (action === "plus_one_week") {
      await pushTaskOneWeek(taskId);
    } else if (action === "cancel") {
      const reason = buildCancelReason();
      if (!reason) {
        setReplanError("Kies een reden of typ een eigen reden.");
        replanReasonInput?.focus();
        return;
      }
      await cancelTask(taskId, reason);
    } else {
      setReplanError("Onbekende actie gekozen.");
      return;
    }

    closeReplanModal();
    await loadManagementOverview();
  } catch (error) {
    setReplanError(error.message || "Herplannen mislukt.");
    setStatus(`Herplannen fout: ${error.message}`);
  } finally {
    applyReplanBtn.disabled = false;
  }
}

function renderTeamBoard(teams) {
  managementTeams.innerHTML = "";
  if (!teams?.length) {
    renderEmpty(managementTeams, "Geen teamdata beschikbaar.");
    return;
  }

  const fragment = document.createDocumentFragment();

  teams.forEach((team, index) => {
    const tasks = [];
    for (const member of team.members || []) {
      for (const task of member.dueTodayTasks || []) {
        tasks.push({
          ...task,
          memberName: member.name,
          memberId: member.contactId,
        });
      }
    }

    tasks.sort((a, b) => {
      const byDecision = decisionRank(a.decisionType) - decisionRank(b.decisionType);
      if (byDecision !== 0) return byDecision;
      const byEffort = Number(b.effortHours || 0) - Number(a.effortHours || 0);
      if (byEffort !== 0) return byEffort;
      return String(a.title || "").localeCompare(String(b.title || ""));
    });

    const teamRow = document.createElement("details");
    teamRow.className = "team-row";
    if (index === 0) teamRow.open = true;

    teamRow.innerHTML = `
      <summary class="team-row-summary">
        <div class="team-row-left">
          <h3>${escapeHtml(team.name)}</h3>
          <p>${team.members.length} profielen • ${team.todayTaskCount} taken • ${fmtHours(
      team.todayHours
    )}</p>
        </div>
        <div class="team-row-right">
          <span>${tasks.length} taken op deze dag</span>
          <span class="team-row-chevron">▾</span>
        </div>
      </summary>
      <div class="team-row-panel">
        ${
          !tasks.length
            ? `<div class="empty-state">Geen taken op gekozen dag voor ${escapeHtml(
                team.name
              )}.</div>`
            : `
          <div class="team-task-list">
            ${tasks
              .map((task) => {
                const description = escapeHtml(task.description || "");
                const taskId = task.taskId || task.id;
                const statusLabelRaw = String(task.statusLabel || task.status || "").trim();
                const statusChip = renderWrikePrioBadge(statusLabelRaw);
                const taskLink = String(task.permalink || "").trim();
                const titleHtml = taskLink
                  ? `<a class="team-task-link" href="${escapeHtml(
                      taskLink
                    )}" target="_blank" rel="noreferrer">${escapeHtml(task.title)}</a>`
                  : `<strong>${escapeHtml(task.title)}</strong>`;
                return `
                  <article class="team-task-item">
                    <div class="team-task-main">
                      <div class="team-task-line">
                        ${statusChip}
                        ${titleHtml}
                      </div>
                      <p class="team-task-meta">${escapeHtml(
                        task.memberName
                      )} • due ${String(task.due || "-").slice(0, 10)} • ${fmtHours(
                  task.effortHours
                )} • ${escapeHtml(
                  task.importance || "Normal"
                )}</p>
                      ${
                        description
                          ? `<details class="team-task-briefing"><summary>Briefing</summary><p>${description.replaceAll(
                              "\n",
                              "<br>"
                            )}</p></details>`
                          : `<p class="team-task-meta">Geen briefing ingevuld.</p>`
                      }
                    </div>
                    <div class="team-task-actions">
                      <button class="mini-btn task-prio" data-task-id="${escapeHtml(
                        taskId
                      )}">Prio</button>
                      <button class="mini-btn task-replan" data-task-id="${escapeHtml(
                        taskId
                      )}" data-task-title="${escapeHtml(task.title)}">Herplannen</button>
                      <button class="mini-btn task-open" data-contact-id="${escapeHtml(
                        task.memberId
                      )}" data-task-id="${escapeHtml(taskId)}">Open team</button>
                    </div>
                  </article>
                `;
              })
              .join("")}
          </div>`
        }
      </div>
    `;

    teamRow.querySelectorAll(".task-prio").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        const taskId = button.dataset.taskId;
        if (!taskId) return;
        try {
          await markTaskPriority(taskId);
          await loadManagementOverview();
        } catch (error) {
          setStatus(`Prio fout: ${error.message}`);
        }
      });
    });

    teamRow.querySelectorAll(".task-replan").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const taskId = button.dataset.taskId;
        const taskTitle = button.dataset.taskTitle || "Geselecteerde taak";
        if (!taskId) return;
        openReplanModal(taskId, taskTitle);
      });
    });

    teamRow.querySelectorAll(".task-open").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const contactId = button.dataset.contactId;
        const taskId = button.dataset.taskId;
        if (!contactId || !taskId) return;
        const params = new URLSearchParams({ contactId, focusTaskId: taskId });
        window.location.href = `/?${params.toString()}`;
      });
    });

    fragment.appendChild(teamRow);
  });

  managementTeams.appendChild(fragment);
}

function renderOverview(payload) {
  const teams = payload.teams || [];
  const profiles = payload.profiles || [];
  const recommendations = payload.recommendations || [];
  renderTeamBoard(teams);

  managementProfiles.innerHTML = "";
  if (!profiles.length) {
    renderEmpty(managementProfiles, "Geen profieldata gevonden.");
  } else {
    const fragment = document.createDocumentFragment();
    for (const profile of profiles.slice(0, 20)) {
      const row = document.createElement("article");
      row.className = "management-item";
      row.innerHTML = `
        <div>
          <strong>${profile.name}</strong>
          <p>${fmtHours(profile.weekHours)} / ${fmtHours(
        profile.weekCapacity
      )} deze week • ${profile.weekTaskCount} taken</p>
          <p>${profile.overdueCount} overdue • ${profile.backlogCount} backlog</p>
        </div>
        <div class="management-item-right">
          <span class="${
            profile.overbooked ? "pill pill-warn" : "pill pill-ok"
          }">${profile.utilizationPct}%</span>
          <button class="mini-btn open-profile">Open team</button>
        </div>
      `;
      row.querySelector(".open-profile").addEventListener("click", () => {
        window.location.href = `/?contactId=${encodeURIComponent(profile.contactId)}`;
      });
      fragment.appendChild(row);
    }
    managementProfiles.appendChild(fragment);
  }

  managementRecommendations.innerHTML = "";
  if (!recommendations.length) {
    renderEmpty(
      managementRecommendations,
      "Geen directe herplan- of cleanup-aanbevelingen."
    );
  } else {
    const fragment = document.createDocumentFragment();
    for (const rec of recommendations.slice(0, 40)) {
      const row = document.createElement("article");
      row.className = "management-item";
      const statusLabelRaw = String(rec.statusLabel || rec.status || "").trim();
      const statusChip = renderWrikePrioBadge(statusLabelRaw);
      const description = rec.description
        ? escapeHtml(rec.description)
        : "Geen beschrijving.";
      row.innerHTML = `
        <div>
          <strong><a href="${rec.permalink}" target="_blank" rel="noreferrer">${escapeHtml(
        rec.title
      )}</a></strong>
          <p>${escapeHtml(rec.contactName)} • due ${String(rec.due || "-").slice(
        0,
        10
      )} • ${fmtHours(rec.effortHours)} • ${escapeHtml(rec.importance || "Normal")}</p>
          <p class="management-desc">${description}</p>
        </div>
        <div class="management-item-right">
          ${statusChip}
          <button class="mini-btn pick-task">Open team</button>
        </div>
      `;
      row.querySelector(".pick-task").addEventListener("click", () => {
        const params = new URLSearchParams({
          contactId: rec.contactId,
          focusTaskId: rec.taskId,
        });
        window.location.href = `/?${params.toString()}`;
      });
      fragment.appendChild(row);
    }
    managementRecommendations.appendChild(fragment);
  }
}

async function loadManagementOverview() {
  const date = managementDateInput.value || todayString();
  const capacity = managementCapacityInput.value || "7";

  loadManagementBtn.disabled = true;
  loadManagementBtn.textContent = "Analyseren...";
  setStatus(`Analyse loopt voor ${date}...`);

  try {
    const query = new URLSearchParams({ date, capacity, limit: "30" });
    const payload = await requestJson(`/api/management-overview?${query.toString()}`);
    renderOverview(payload);
  } catch (error) {
    renderEmpty(managementProfiles, `Fout: ${error.message}`);
    renderEmpty(managementRecommendations, "Kon aanbevelingen niet laden.");
  } finally {
    loadManagementBtn.disabled = false;
    loadManagementBtn.textContent = "Analyseer iedereen";
  }
}

async function init() {
  managementDateInput.value = todayString();
  await loadManagementOverview();
}

managementDateInput.addEventListener("change", () => loadManagementOverview());
loadManagementBtn.addEventListener("click", () => loadManagementOverview());
replanActionInput?.addEventListener("change", syncReplanReasonVisibility);
replanReasonPresetInput?.addEventListener("change", syncReplanReasonVisibility);
applyReplanBtn?.addEventListener("click", () => applyReplanAction());
closeReplanBtn?.addEventListener("click", () => closeReplanModal());

replanModal?.addEventListener("click", (event) => {
  if (event.target === replanModal) closeReplanModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && replanModal && !replanModal.classList.contains("hidden")) {
    closeReplanModal();
  }
});

init();
