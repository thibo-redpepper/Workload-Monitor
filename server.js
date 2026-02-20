#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const ENV_FILE = path.join(ROOT_DIR, ".env", ".env.local");

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  const env = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function persistEnvValues(updates) {
  try {
    if (!fs.existsSync(ENV_FILE)) return;
    const raw = fs.readFileSync(ENV_FILE, "utf8");
    const lines = raw.split(/\r?\n/);
    const pending = new Map(
      Object.entries(updates).filter(
        ([key, value]) => key && typeof value === "string" && value.length > 0
      )
    );

    const nextLines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const idx = line.indexOf("=");
      if (idx === -1) return line;
      const key = line.slice(0, idx).trim();
      if (!pending.has(key)) return line;
      const value = pending.get(key);
      pending.delete(key);
      return `${key}=${value}`;
    });

    for (const [key, value] of pending.entries()) {
      nextLines.push(`${key}=${value}`);
    }

    fs.writeFileSync(ENV_FILE, nextLines.join("\n"));
  } catch (error) {
    console.warn("Could not persist refreshed Wrike tokens:", error.message);
  }
}

const fileEnv = parseEnvFile(ENV_FILE);

const config = {
  wrikeHost: process.env.WRIKE_HOST || fileEnv.WRIKE_HOST || "www.wrike.com",
  wrikeClientId: process.env.WRIKE_CLIENT_ID || fileEnv.WRIKE_CLIENT_ID || "",
  wrikeClientSecret:
    process.env.WRIKE_CLIENT_SECRET || fileEnv.WRIKE_CLIENT_SECRET || "",
  wrikeRefreshToken:
    process.env.WRIKE_REFRESH_TOKEN || fileEnv.WRIKE_REFRESH_TOKEN || "",
  wrikeAccessToken:
    process.env.WRIKE_ACCESS_TOKEN ||
    fileEnv.WRIKE_ACCESS_TOKEN ||
    process.env.WRIKE_TOKEN ||
    fileEnv.WRIKE_TOKEN ||
    "",
  wrikePlanningContactId:
    process.env.WRIKE_PLANNING_CONTACT_ID ||
    fileEnv.WRIKE_PLANNING_CONTACT_ID ||
    "",
  wrikePlanningMentionLabel:
    process.env.WRIKE_PLANNING_MENTION_LABEL ||
    fileEnv.WRIKE_PLANNING_MENTION_LABEL ||
    "Planning",
  port: Number(process.env.PORT || 8788),
};

if (!config.wrikeAccessToken && !config.wrikeRefreshToken) {
  console.warn(
    "No Wrike tokens found. Configure WRIKE_ACCESS_TOKEN (or WRIKE_TOKEN) and WRIKE_REFRESH_TOKEN via environment variables."
  );
}

if (!config.wrikeAccessToken && config.wrikeRefreshToken) {
  console.warn(
    "WRIKE_ACCESS_TOKEN missing. Server will try to auto-refresh via WRIKE_REFRESH_TOKEN."
  );
}

const actionLog = [];
let wrikeSupportsTaskDescriptionField = true;
let customStatusNameById = new Map();
let workflowStatusCacheAt = 0;
const WORKFLOW_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
let planningMentionCache = null;
let planningMentionCacheAt = 0;
const PLANNING_MENTION_CACHE_TTL_MS = 5 * 60 * 1000;

const MARKETING_NAMES = new Set(["thibo", "dries", "bjorn", "diego"]);
const DESIGN_NAMES = new Set(["chelsea", "dannii"]);
const ACCOUNT_MANAGEMENT_NAMES = new Set(["nick", "stephen"]);

function normalizePersonName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function resolveTeamName(firstName, fullName) {
  const normalizedFirst = normalizePersonName(firstName);
  if (MARKETING_NAMES.has(normalizedFirst)) return "Marketing";
  if (DESIGN_NAMES.has(normalizedFirst)) return "Design";
  if (ACCOUNT_MANAGEMENT_NAMES.has(normalizedFirst)) return "Account Management";

  const leadName = normalizePersonName(String(fullName || "").split(" ")[0]);
  if (MARKETING_NAMES.has(leadName)) return "Marketing";
  if (DESIGN_NAMES.has(leadName)) return "Design";
  if (ACCOUNT_MANAGEMENT_NAMES.has(leadName)) return "Account Management";
  return "Overig";
}

async function refreshWorkflowStatusMap(force = false) {
  const now = Date.now();
  if (
    !force &&
    customStatusNameById.size > 0 &&
    now - workflowStatusCacheAt < WORKFLOW_STATUS_CACHE_TTL_MS
  ) {
    return;
  }

  try {
    const payload = await wrikeGet("/workflows");
    const nextMap = new Map();
    for (const workflow of payload.data || []) {
      for (const status of workflow.customStatuses || []) {
        if (status?.id && status?.name) nextMap.set(status.id, status.name);
      }
    }
    customStatusNameById = nextMap;
    workflowStatusCacheAt = now;
  } catch {
    // Keep existing cache or fallback to standard status field.
  }
}

function taskStatusLabel(task) {
  const customStatusId = task?.customStatusId;
  if (customStatusId && customStatusNameById.has(customStatusId)) {
    return customStatusNameById.get(customStatusId);
  }
  return String(task?.status || "Unknown");
}

function isWrikePrioTask(task) {
  const statusLabel = normalizePersonName(taskStatusLabel(task));
  return (
    statusLabel.includes("prio") ||
    statusLabel.includes("priorit") ||
    statusLabel.includes("urgent")
  );
}

function escapeCommentHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function resolvePlanningMention(force = false) {
  const now = Date.now();
  if (
    !force &&
    planningMentionCache &&
    now - planningMentionCacheAt < PLANNING_MENTION_CACHE_TTL_MS
  ) {
    return planningMentionCache;
  }

  if (config.wrikePlanningContactId) {
    const fallbackLabel = String(config.wrikePlanningMentionLabel || "Planning")
      .replace(/^@+/, "")
      .trim();
    planningMentionCache = {
      id: config.wrikePlanningContactId,
      label: fallbackLabel || "Planning",
    };
    planningMentionCacheAt = now;
    return planningMentionCache;
  }

  const payload = await wrikeGet("/contacts");
  const contacts = (payload.data || []).filter((contact) => contact?.type === "Person");
  const normalizedTarget = normalizePersonName("planning");
  const match = contacts.find((contact) => {
    const first = normalizePersonName(contact.firstName);
    const full = normalizePersonName(
      `${contact.firstName || ""} ${contact.lastName || ""}`.trim()
    );
    const emailLocal = String(contact.primaryEmail || "")
      .toLowerCase()
      .split("@")[0];
    return (
      first === normalizedTarget ||
      full === normalizedTarget ||
      emailLocal === normalizedTarget
    );
  });

  if (!match?.id) {
    planningMentionCache = null;
    planningMentionCacheAt = now;
    return null;
  }

  const label = String(
    `${match.firstName || ""} ${match.lastName || ""}`.trim() ||
      config.wrikePlanningMentionLabel ||
      "Planning"
  )
    .replace(/^@+/, "")
    .trim();

  planningMentionCache = { id: match.id, label: label || "Planning" };
  planningMentionCacheAt = now;
  return planningMentionCache;
}

function buildPlanningMentionComment(reasonText, mention) {
  if (!mention?.id) return null;
  const label = String(mention.label || "Planning")
    .replace(/^@+/, "")
    .trim();
  const safeReason = escapeCommentHtml(reasonText).replace(/\r?\n/g, "<br>");
  const mentionHtml = `<a class="stream-user-id avatar" rel="${escapeCommentHtml(
    mention.id
  )}">@${escapeCommentHtml(label || "Planning")}</a>`;
  return `${mentionHtml} ${safeReason}`.trim();
}

function syncConfigFromEnvFile() {
  const latest = parseEnvFile(ENV_FILE);
  const previousPlanningContactId = config.wrikePlanningContactId;
  const previousPlanningMentionLabel = config.wrikePlanningMentionLabel;
  if (latest.WRIKE_HOST) config.wrikeHost = latest.WRIKE_HOST;
  if (latest.WRIKE_CLIENT_ID) config.wrikeClientId = latest.WRIKE_CLIENT_ID;
  if (latest.WRIKE_CLIENT_SECRET) {
    config.wrikeClientSecret = latest.WRIKE_CLIENT_SECRET;
  }
  if (latest.WRIKE_REFRESH_TOKEN) {
    config.wrikeRefreshToken = latest.WRIKE_REFRESH_TOKEN;
  }
  if (latest.WRIKE_ACCESS_TOKEN || latest.WRIKE_TOKEN) {
    config.wrikeAccessToken = latest.WRIKE_ACCESS_TOKEN || latest.WRIKE_TOKEN;
  }
  if (typeof latest.WRIKE_PLANNING_CONTACT_ID === "string") {
    config.wrikePlanningContactId = latest.WRIKE_PLANNING_CONTACT_ID.trim();
  }
  if (latest.WRIKE_PLANNING_MENTION_LABEL) {
    config.wrikePlanningMentionLabel = latest.WRIKE_PLANNING_MENTION_LABEL.trim();
  }

  if (
    previousPlanningContactId !== config.wrikePlanningContactId ||
    previousPlanningMentionLabel !== config.wrikePlanningMentionLabel
  ) {
    planningMentionCache = null;
    planningMentionCacheAt = 0;
  }
}

function appendLog(entry) {
  actionLog.unshift({
    at: new Date().toISOString(),
    ...entry,
  });
  if (actionLog.length > 300) actionLog.length = 300;
}

async function persistWrikeCredentials() {
  persistEnvValues({
    WRIKE_HOST: config.wrikeHost,
    WRIKE_TOKEN: config.wrikeAccessToken,
    WRIKE_ACCESS_TOKEN: config.wrikeAccessToken,
    WRIKE_REFRESH_TOKEN: config.wrikeRefreshToken,
  });
}

async function refreshAccessToken() {
  if (
    !config.wrikeRefreshToken ||
    !config.wrikeClientId ||
    !config.wrikeClientSecret
  ) {
    return false;
  }

  const body = new URLSearchParams({
    client_id: config.wrikeClientId,
    client_secret: config.wrikeClientSecret,
    grant_type: "refresh_token",
    refresh_token: config.wrikeRefreshToken,
  });

  const response = await fetch("https://login.wrike.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) return false;

  config.wrikeAccessToken = payload.access_token;
  if (payload.refresh_token) config.wrikeRefreshToken = payload.refresh_token;
  if (payload.host) config.wrikeHost = payload.host;
  await persistWrikeCredentials();
  return true;
}

async function wrikeRequest(method, endpoint, formData = null, retry = true) {
  syncConfigFromEnvFile();

  if (!config.wrikeAccessToken && config.wrikeRefreshToken) {
    await refreshAccessToken();
  }

  if (!config.wrikeAccessToken) {
    throw new Error(
      "Wrike access token ontbreekt. Configureer WRIKE_ACCESS_TOKEN (of WRIKE_TOKEN) in je environment secrets."
    );
  }

  const tokenUsedAtStart = config.wrikeAccessToken;
  const url = `https://${config.wrikeHost}/api/v4${endpoint}`;
  const headers = {
    Authorization: `bearer ${config.wrikeAccessToken}`,
  };
  const options = { method, headers };

  if (formData && method !== "GET") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    options.body = new URLSearchParams(formData).toString();
  }

  const response = await fetch(url, options);

  const payload = await response.json().catch(() => ({}));
  if (response.ok) return payload;

  const tokenError = response.status === 401 || payload.error === "invalid_token";
  if (retry && tokenError) {
    syncConfigFromEnvFile();
    const refreshed = await refreshAccessToken();
    if (refreshed) return wrikeRequest(method, endpoint, formData, false);
    syncConfigFromEnvFile();
    if (
      config.wrikeAccessToken &&
      config.wrikeAccessToken !== tokenUsedAtStart
    ) {
      return wrikeRequest(method, endpoint, formData, false);
    }
  }

  let detail = payload.errorDescription || payload.error || response.statusText;
  if (tokenError) {
    detail +=
      ". Re-auth nodig: voer scripts/wrike-reauth.sh uit om nieuwe tokens op te halen.";
  }
  const error = new Error(`Wrike request failed (${response.status}): ${detail}`);
  error.status = response.status;
  throw error;
}

function wrikeGet(endpoint) {
  return wrikeRequest("GET", endpoint);
}

function wrikePut(endpoint, formData) {
  return wrikeRequest("PUT", endpoint, formData);
}

function wrikePost(endpoint, formData) {
  return wrikeRequest("POST", endpoint, formData);
}

function wrikeDelete(endpoint) {
  return wrikeRequest("DELETE", endpoint);
}

function isUnsupportedDescriptionFieldError(error) {
  const message = String(error?.message || "").toLowerCase();
  const status = Number(error?.status || 0);
  if (status !== 400) return false;
  return (
    message.includes("description") &&
    (message.includes("field") ||
      message.includes("unknown") ||
      message.includes("invalid") ||
      message.includes("unsupported"))
  );
}

function formatDateYYYYMMDD(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseDateOnly(dateString) {
  const [y, m, d] = String(dateString)
    .split("-")
    .map((x) => Number(x));
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(dateString, days) {
  const d = parseDateOnly(dateString);
  d.setUTCDate(d.getUTCDate() + days);
  return formatDateYYYYMMDD(d);
}

function nextMonday(dateString) {
  const d = parseDateOnly(dateString);
  const day = d.getUTCDay(); // 0 = Sunday
  let delta = (8 - day) % 7;
  if (delta === 0) delta = 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return formatDateYYYYMMDD(d);
}

function isoWeekNumber(dateString) {
  const d = parseDateOnly(dateString);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function taskDueDate(task) {
  const due = task?.dates?.due;
  return typeof due === "string" ? due.slice(0, 10) : null;
}

function taskStartDate(task) {
  const start = task?.dates?.start;
  return typeof start === "string" ? start.slice(0, 10) : null;
}

function effortHours(task) {
  const totalEffort = Number(task?.effortAllocation?.totalEffort || 0);
  // Wrike effort values are minutes in most setups.
  return totalEffort / 60;
}

function sumHours(tasks) {
  return tasks.reduce((acc, task) => acc + effortHours(task), 0);
}

function importanceRank(task) {
  const value = String(task?.importance || "Normal").toLowerCase();
  if (value === "highest") return 4;
  if (value === "high") return 3;
  if (value === "normal") return 2;
  return 1;
}

function normalizeDescription(raw) {
  const text = String(raw || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

function truncateText(text, maxLength = 220) {
  const normalized = String(text || "");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trim()}…`;
}

function mapTask(task) {
  const description = normalizeDescription(task?.description);
  const statusLabel = taskStatusLabel(task);
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    statusLabel,
    customStatusId: task?.customStatusId || null,
    importance: task.importance,
    due: task?.dates?.due || null,
    dueType: task?.dates?.type || null,
    effortMinutes: Number(task?.effortAllocation?.totalEffort || 0),
    effortHours: Number(effortHours(task).toFixed(2)),
    description,
    descriptionPreview: truncateText(description, 220),
    permalink: task.permalink,
  };
}

async function getAllTasksForContact(contactId) {
  const tasks = [];
  let nextPageToken = null;
  let safety = 0;

  while (safety < 20) {
    safety += 1;
    const params = new URLSearchParams();
    params.set("responsibles", `["${contactId}"]`);
    params.set("status", "Active");
    const fields = wrikeSupportsTaskDescriptionField
      ? "[effortAllocation,description]"
      : "[effortAllocation]";
    params.set("fields", fields);
    params.set("pageSize", "1000");
    if (nextPageToken) params.set("nextPageToken", nextPageToken);

    let payload;
    try {
      payload = await wrikeGet(`/tasks?${params.toString()}`);
    } catch (error) {
      if (wrikeSupportsTaskDescriptionField && isUnsupportedDescriptionFieldError(error)) {
        wrikeSupportsTaskDescriptionField = false;
        safety -= 1;
        continue;
      }
      throw error;
    }
    tasks.push(...(payload.data || []));
    if (!payload.nextPageToken) break;
    nextPageToken = payload.nextPageToken;
  }

  return tasks;
}

function chunk(list, size) {
  const result = [];
  for (let i = 0; i < list.length; i += size) {
    result.push(list.slice(i, i + size));
  }
  return result;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function runner() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }

  const workers = [];
  const workerCount = Math.min(concurrency, items.length);
  for (let i = 0; i < workerCount; i += 1) workers.push(runner());
  await Promise.all(workers);
  return results;
}

async function getTasksByIds(taskIds) {
  const ids = [...new Set(taskIds.filter(Boolean))];
  const chunks = chunk(ids, 80);
  const out = [];

  for (const group of chunks) {
    const fields = wrikeSupportsTaskDescriptionField
      ? "[effortAllocation,description]"
      : "[effortAllocation]";
    let payload;
    try {
      payload = await wrikeGet(`/tasks/${group.join(",")}?fields=${fields}`);
    } catch (error) {
      if (wrikeSupportsTaskDescriptionField && isUnsupportedDescriptionFieldError(error)) {
        wrikeSupportsTaskDescriptionField = false;
        payload = await wrikeGet(
          `/tasks/${group.join(",")}?fields=[effortAllocation]`
        );
      } else {
        throw error;
      }
    }
    out.push(...(payload.data || []));
  }
  return out;
}

function daysDiff(fromDate, toDate) {
  const a = parseDateOnly(fromDate);
  const b = parseDateOnly(toDate);
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

function buildDatesPayload(task, options) {
  const currentDue = taskDueDate(task);
  const currentStart = taskStartDate(task);
  const hasTargetDate = typeof options.targetDate === "string" && options.targetDate;

  let nextDue = null;
  let nextStart = null;

  if (hasTargetDate) {
    nextDue = options.targetDate;
    if (currentStart && currentDue) {
      const delta = daysDiff(currentDue, options.targetDate);
      nextStart = addDays(currentStart, delta);
    } else if (currentStart && !currentDue) {
      nextStart = options.targetDate;
    }
  } else {
    const shiftDays = Number(options.shiftDays || 0);
    if (!currentDue) {
      return null;
    }
    nextDue = addDays(currentDue, shiftDays);
    nextStart = currentStart ? addDays(currentStart, shiftDays) : null;
  }

  if (!nextDue) return null;
  const dates = { type: "Planned", due: nextDue };
  if (nextStart) dates.start = nextStart;
  return dates;
}

async function moveTask(task, options) {
  const datesPayload = buildDatesPayload(task, options);
  if (!datesPayload) {
    throw new Error(
      "Task has no due date. Choose a target date in the planning popup first."
    );
  }
  await wrikePut(`/tasks/${task.id}`, { dates: JSON.stringify(datesPayload) });
  return datesPayload;
}

async function deleteTask(taskId) {
  await wrikeDelete(`/tasks/${taskId}`);
}

async function addTaskComment(taskId, text) {
  await wrikePost(`/tasks/${taskId}/comments`, { text });
}

async function cancelTaskWithComment(task, reasonText) {
  const cleanReason = String(reasonText || "").trim();
  if (!cleanReason) {
    throw new Error("Cancelreden ontbreekt.");
  }

  const mention = await resolvePlanningMention();
  const mentionComment = buildPlanningMentionComment(cleanReason, mention);
  if (!mentionComment) {
    throw new Error(
      "Planning-contact niet gevonden voor @mention. Gebruik WRIKE_PLANNING_CONTACT_ID of maak een contact 'Planning'."
    );
  }

  await addTaskComment(task.id, mentionComment);

  try {
    await wrikePut(`/tasks/${task.id}`, { status: "Cancelled" });
    return "Cancelled";
  } catch (firstError) {
    try {
      await wrikePut(`/tasks/${task.id}`, { status: "Canceled" });
      return "Canceled";
    } catch {
      throw new Error(
        `Comment geplaatst, maar status wijzigen naar Cancelled faalde: ${firstError.message}`
      );
    }
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };

  res.writeHead(200, {
    "Content-Type": contentTypes[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = requestUrl.pathname;
    const method = req.method || "GET";

    if (pathname === "/api/health" && method === "GET") {
      sendJson(res, 200, {
        ok: true,
        wrikeHost: config.wrikeHost,
        secretStore: "env",
        hasAccessToken: Boolean(config.wrikeAccessToken),
        hasRefreshToken: Boolean(config.wrikeRefreshToken),
      });
      return;
    }

    if (pathname === "/api/contacts" && method === "GET") {
      const payload = await wrikeGet("/contacts");
      const contacts = (payload.data || [])
        .filter((c) => c.type === "Person")
        .map((c) => ({
          id: c.id,
          firstName: c.firstName || "",
          lastName: c.lastName || "",
          fullName: `${c.firstName || ""} ${c.lastName || ""}`.trim() || c.id,
          email: c.primaryEmail || "",
          me: Boolean(c.me),
          active:
            (c.profiles || []).some((p) => p.active) ||
            (c.profiles || []).length === 0,
        }))
        .filter((c) => c.active)
        .sort((a, b) => a.fullName.localeCompare(b.fullName));

      sendJson(res, 200, { data: contacts });
      return;
    }

    if (pathname === "/api/action-log" && method === "GET") {
      sendJson(res, 200, { data: actionLog.slice(0, 120) });
      return;
    }

    if (pathname === "/api/management-overview" && method === "GET") {
      await refreshWorkflowStatusMap();
      const selectedDate =
        requestUrl.searchParams.get("date") || formatDateYYYYMMDD(new Date());
      const capacityHours = Number(requestUrl.searchParams.get("capacity") || 7);
      const limit = Number(requestUrl.searchParams.get("limit") || 30);
      const weekEnd = addDays(selectedDate, 6);
      const staleDate = addDays(selectedDate, -14);

      const contactsPayload = await wrikeGet("/contacts");
      const contacts = (contactsPayload.data || [])
        .filter((c) => c.type === "Person")
        .filter((c) => {
          const active =
            (c.profiles || []).some((p) => p.active) ||
            (c.profiles || []).length === 0;
          if (!active) return false;
          const email = String(c.primaryEmail || "").toLowerCase();
          return !email.endsWith("@wrike-robot.com");
        })
        .slice(0, limit)
        .map((c) => ({
          id: c.id,
          firstName: c.firstName || "",
          fullName: `${c.firstName || ""} ${c.lastName || ""}`.trim() || c.id,
          email: c.primaryEmail || "",
        }));

      const profileRows = await mapWithConcurrency(
        contacts,
        5,
        async (contact) => {
          const tasks = await getAllTasksForContact(contact.id);

          const dueWeek = [];
          const overdue = [];
          const backlog = [];
          const rescheduleCandidates = [];
          const cleanupCandidates = [];
          const mustKeepToday = [];
          const reviewToday = [];
          const dueTodayTasks = [];

          for (const task of tasks) {
            const dueDate = taskDueDate(task);
            const hours = effortHours(task);
            const prioInWrike = isWrikePrioTask(task);
            const statusLabel = taskStatusLabel(task);

            if (!dueDate) {
              backlog.push(task);
              if (!prioInWrike && hours <= 1.0) cleanupCandidates.push(task);
              continue;
            }

            if (dueDate < selectedDate) {
              overdue.push(task);
              if (dueDate <= staleDate && !prioInWrike && hours <= 2.0) {
                cleanupCandidates.push(task);
              }
              continue;
            }

            if (dueDate === selectedDate) {
              let decisionType = "reschedule";
              let decision = "Kan opschuiven";
              let reason = `Geen Prio-status in Wrike (${statusLabel}).`;

              if (prioInWrike) {
                decisionType = "keep_today";
                decision = "Nodig vandaag";
                reason = `Status in Wrike: ${statusLabel}.`;
              } else if (hours <= 1.0) {
                decisionType = "cleanup";
                decision = "Mogelijk niet nodig";
                reason = `Geen Prio-status in Wrike (${statusLabel}) en kleine taak.`;
                cleanupCandidates.push(task);
              }

              if (decisionType === "keep_today") mustKeepToday.push(task);
              else reviewToday.push(task);

              dueTodayTasks.push({
                ...mapTask(task),
                decisionType,
                decision,
                reason,
              });
            }

            if (dueDate <= weekEnd) {
              dueWeek.push(task);
              if (!prioInWrike && hours <= capacityHours * 0.8) {
                rescheduleCandidates.push(task);
              }
            }
          }

          const weekHours = Number(sumHours(dueWeek).toFixed(2));
          const weekCapacity = Number((capacityHours * 5).toFixed(2));
          const utilizationPct =
            weekCapacity > 0 ? Number(((weekHours / weekCapacity) * 100).toFixed(1)) : 0;
          const overbooked = utilizationPct > 100;
          const dueTodayHours = Number(
            dueTodayTasks.reduce((sum, task) => sum + Number(task.effortHours || 0), 0).toFixed(2)
          );
          const decisionRank = { keep_today: 0, reschedule: 1, cleanup: 2 };
          dueTodayTasks.sort((a, b) => {
            const byDecision =
              (decisionRank[a.decisionType] ?? 9) - (decisionRank[b.decisionType] ?? 9);
            if (byDecision !== 0) return byDecision;
            return Number(b.effortHours || 0) - Number(a.effortHours || 0);
          });

          return {
            contactId: contact.id,
            firstName: contact.firstName,
            name: contact.fullName,
            email: contact.email,
            openTaskCount: tasks.length,
            weekTaskCount: dueWeek.length,
            weekHours,
            weekCapacity,
            utilizationPct,
            overbooked,
            overdueCount: overdue.length,
            overdueHours: Number(sumHours(overdue).toFixed(2)),
            backlogCount: backlog.length,
            backlogHours: Number(sumHours(backlog).toFixed(2)),
            dueTodayTaskCount: dueTodayTasks.length,
            dueTodayHours,
            dueTodayTasks,
            mustKeepTodayCount: mustKeepToday.length,
            reviewTodayCount: reviewToday.length,
            rescheduleCandidateCount: rescheduleCandidates.length,
            cleanupCandidateCount: cleanupCandidates.length,
            topMustKeepToday: mustKeepToday
              .sort((a, b) => {
                return Number(effortHours(b)) - Number(effortHours(a));
              })
              .slice(0, 3)
              .map(mapTask),
            topReschedule: rescheduleCandidates
              .sort((a, b) => {
                const effortDiff = Number(effortHours(b)) - Number(effortHours(a));
                if (effortDiff !== 0) return effortDiff;
                return taskDueDate(b)?.localeCompare(taskDueDate(a) || "") || 0;
              })
              .slice(0, 3)
              .map(mapTask),
            topCleanup: cleanupCandidates
              .sort((a, b) => {
                const ad = taskDueDate(a) || "9999-12-31";
                const bd = taskDueDate(b) || "9999-12-31";
                return ad.localeCompare(bd);
              })
              .slice(0, 2)
              .map(mapTask),
          };
        }
      );

      const profiles = profileRows.sort((a, b) => b.utilizationPct - a.utilizationPct);

      const recommendations = [];
      for (const profile of profiles) {
        for (const task of profile.topMustKeepToday || []) {
          recommendations.push({
            type: "keep_today",
            decision: "Nodig vandaag",
            taskId: task.id,
            title: task.title,
            description: task.descriptionPreview || "",
            contactId: profile.contactId,
            contactName: profile.name,
            due: task.due,
            effortHours: task.effortHours,
            status: task.status,
            statusLabel: task.statusLabel,
            importance: task.importance,
            permalink: task.permalink,
            reason: `Status in Wrike: ${task.statusLabel || task.status || "Prio"}.`,
          });
        }

        if (!profile.overbooked) continue;
        for (const task of profile.topReschedule) {
          recommendations.push({
            type: "reschedule",
            decision: "Kan opschuiven",
            taskId: task.id,
            title: task.title,
            description: task.descriptionPreview || "",
            contactId: profile.contactId,
            contactName: profile.name,
            due: task.due,
            effortHours: task.effortHours,
            status: task.status,
            statusLabel: task.statusLabel,
            importance: task.importance,
            permalink: task.permalink,
            reason: `Weekload ${profile.utilizationPct}% op ${profile.name}`,
          });
        }

        for (const task of profile.topCleanup || []) {
          recommendations.push({
            type: "cleanup",
            decision: "Mogelijk niet nodig",
            taskId: task.id,
            title: task.title,
            description: task.descriptionPreview || "",
            contactId: profile.contactId,
            contactName: profile.name,
            due: task.due,
            effortHours: task.effortHours,
            status: task.status,
            statusLabel: task.statusLabel,
            importance: task.importance,
            permalink: task.permalink,
            reason: "Lage impact of oude taak in backlog/overdue",
          });
        }
      }

      recommendations.sort((a, b) => {
        const rank = { keep_today: 0, reschedule: 1, cleanup: 2 };
        const byType = (rank[a.type] ?? 9) - (rank[b.type] ?? 9);
        if (byType !== 0) return byType;
        const ad = String(a.due || "9999-12-31");
        const bd = String(b.due || "9999-12-31");
        return ad.localeCompare(bd);
      });

      const grouped = {
        Marketing: [],
        Design: [],
        "Account Management": [],
        Overig: [],
      };

      for (const profile of profiles) {
        const teamName = resolveTeamName(profile.firstName, profile.name);
        grouped[teamName].push({
          contactId: profile.contactId,
          name: profile.name,
          teamName,
          dueTodayTaskCount: profile.dueTodayTaskCount,
          dueTodayHours: profile.dueTodayHours,
          dueTodayTasks: profile.dueTodayTasks,
          utilizationPct: profile.utilizationPct,
          overbooked: profile.overbooked,
        });
      }

      for (const teamName of Object.keys(grouped)) {
        grouped[teamName].sort((a, b) => {
          if (b.dueTodayHours !== a.dueTodayHours) {
            return b.dueTodayHours - a.dueTodayHours;
          }
          return a.name.localeCompare(b.name);
        });
      }

      const teams = ["Marketing", "Design", "Account Management", "Overig"].map(
        (teamName) => {
        const members = grouped[teamName];
        return {
          name: teamName,
          members,
          todayTaskCount: members.reduce((sum, member) => sum + member.dueTodayTaskCount, 0),
          todayHours: Number(
            members.reduce((sum, member) => sum + Number(member.dueTodayHours || 0), 0).toFixed(2)
          ),
        };
        }
      );

      sendJson(res, 200, {
        summary: {
          date: selectedDate,
          contactsAnalyzed: profiles.length,
          openTasks: profiles.reduce((sum, p) => sum + p.openTaskCount, 0),
          todayTasks: profiles.reduce((sum, p) => sum + p.dueTodayTaskCount, 0),
          todayHours: Number(
            profiles.reduce((sum, p) => sum + Number(p.dueTodayHours || 0), 0).toFixed(2)
          ),
          overbookedProfiles: profiles.filter((p) => p.overbooked).length,
          rescheduleCandidates: profiles.reduce(
            (sum, p) => sum + p.rescheduleCandidateCount,
            0
          ),
          mustKeepToday: profiles.reduce((sum, p) => sum + p.mustKeepTodayCount, 0),
          cleanupCandidates: profiles.reduce(
            (sum, p) => sum + p.cleanupCandidateCount,
            0
          ),
        },
        teams,
        profiles,
        recommendations: recommendations.slice(0, 25),
      });
      return;
    }

    if (pathname === "/api/workload" && method === "GET") {
      await refreshWorkflowStatusMap();
      const contactId = requestUrl.searchParams.get("contactId");
      const date = requestUrl.searchParams.get("date");
      const capacityHours = Number(requestUrl.searchParams.get("capacity") || 7);

      if (!contactId || !date) {
        sendJson(res, 400, {
          error: "Missing required query params: contactId, date",
        });
        return;
      }

      const selectedDate = date;
      const endOfWeek = addDays(selectedDate, 6);
      const nextWeekStart = nextMonday(selectedDate);
      const nextWeekEnd = addDays(nextWeekStart, 6);
      const nextWorkDays = Array.from({ length: 5 }, (_, i) =>
        addDays(nextWeekStart, i)
      );
      const tasks = await getAllTasksForContact(contactId);

      const dueToday = [];
      const overdue = [];
      const upcomingWeek = [];
      const backlog = [];
      const dueHoursByDate = new Map();
      const dueCountByDate = new Map();

      for (const task of tasks) {
        const dueDate = taskDueDate(task);
        if (!dueDate) {
          backlog.push(task);
          continue;
        }

        dueHoursByDate.set(
          dueDate,
          (dueHoursByDate.get(dueDate) || 0) + effortHours(task)
        );
        dueCountByDate.set(dueDate, (dueCountByDate.get(dueDate) || 0) + 1);

        if (dueDate === selectedDate) {
          dueToday.push(task);
          continue;
        }

        if (dueDate < selectedDate) {
          overdue.push(task);
          continue;
        }

        if (dueDate <= endOfWeek) {
          upcomingWeek.push(task);
        }
      }

      const dueTodayHours = sumHours(dueToday);
      const loadPct = capacityHours > 0 ? (dueTodayHours / capacityHours) * 100 : 0;
      const nextWeekDays = nextWorkDays.map((dayDate) => {
        const hours = Number((dueHoursByDate.get(dayDate) || 0).toFixed(2));
        const count = dueCountByDate.get(dayDate) || 0;
        const overload = Math.max(0, hours - capacityHours);
        return {
          date: dayDate,
          hours,
          taskCount: count,
          overbooked: hours > capacityHours,
          overloadHours: Number(overload.toFixed(2)),
        };
      });
      const nextWeekHours = Number(
        nextWeekDays.reduce((sum, day) => sum + day.hours, 0).toFixed(2)
      );
      const nextWeekOverbookedDays = nextWeekDays.filter((d) => d.overbooked).length;
      const nextWeekPeakHours = Number(
        Math.max(...nextWeekDays.map((d) => d.hours), 0).toFixed(2)
      );

      sendJson(res, 200, {
        summary: {
          date: selectedDate,
          capacityHours,
          dueTodayCount: dueToday.length,
          dueTodayHours: Number(dueTodayHours.toFixed(2)),
          overdueCount: overdue.length,
          overdueHours: Number(sumHours(overdue).toFixed(2)),
          upcomingWeekCount: upcomingWeek.length,
          upcomingWeekHours: Number(sumHours(upcomingWeek).toFixed(2)),
          backlogCount: backlog.length,
          backlogHours: Number(sumHours(backlog).toFixed(2)),
          utilizationPct: Number(loadPct.toFixed(1)),
        },
        weekPreview: {
          startDate: nextWeekStart,
          endDate: nextWeekEnd,
          isoWeek: isoWeekNumber(nextWeekStart),
          capacityHours,
          totalHours: nextWeekHours,
          overbookedDays: nextWeekOverbookedDays,
          peakDayHours: nextWeekPeakHours,
          days: nextWeekDays,
        },
        buckets: {
          dueToday: dueToday.map(mapTask),
          overdue: overdue.map(mapTask),
          upcomingWeek: upcomingWeek.map(mapTask),
          backlog: backlog.map(mapTask),
        },
      });
      return;
    }

    if (pathname === "/api/planning-options" && method === "GET") {
      await refreshWorkflowStatusMap();
      const contactId = requestUrl.searchParams.get("contactId");
      const fromDate = requestUrl.searchParams.get("fromDate");
      const capacityHours = Number(requestUrl.searchParams.get("capacity") || 7);
      const taskIdsRaw = requestUrl.searchParams.get("taskIds") || "";
      const taskIds = taskIdsRaw
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);

      if (!contactId || !fromDate || taskIds.length === 0) {
        sendJson(res, 400, {
          error: "Missing required params: contactId, fromDate, taskIds",
        });
        return;
      }

      const tasks = await getAllTasksForContact(contactId);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const selectedTasks = [];

      for (const id of taskIds) {
        if (byId.has(id)) {
          selectedTasks.push(byId.get(id));
        }
      }

      const missingIds = taskIds.filter((id) => !byId.has(id));
      if (missingIds.length) {
        const fetched = await getTasksByIds(missingIds);
        selectedTasks.push(...fetched);
      }

      const selectedHours = sumHours(selectedTasks);
      const dayHours = new Map();
      const selectedHoursByDay = new Map();

      for (const task of tasks) {
        const dueDate = taskDueDate(task);
        if (!dueDate) continue;
        dayHours.set(dueDate, (dayHours.get(dueDate) || 0) + effortHours(task));
      }

      for (const task of selectedTasks) {
        const dueDate = taskDueDate(task);
        if (!dueDate) continue;
        selectedHoursByDay.set(
          dueDate,
          (selectedHoursByDay.get(dueDate) || 0) + effortHours(task)
        );
      }

      const days = [];
      for (let i = 0; i < 14; i += 1) {
        const date = addDays(fromDate, i);
        const currentScheduled =
          (dayHours.get(date) || 0) - (selectedHoursByDay.get(date) || 0);
        const afterMove = currentScheduled + selectedHours;
        const freeBefore = capacityHours - currentScheduled;
        const freeAfter = capacityHours - afterMove;
        const utilizationAfter =
          capacityHours > 0 ? (afterMove / capacityHours) * 100 : 0;

        days.push({
          date,
          scheduledHours: Number(currentScheduled.toFixed(2)),
          selectedHours: Number(selectedHours.toFixed(2)),
          afterMoveHours: Number(afterMove.toFixed(2)),
          freeHoursBefore: Number(freeBefore.toFixed(2)),
          freeHoursAfter: Number(freeAfter.toFixed(2)),
          fits: afterMove <= capacityHours,
          utilizationAfterPct: Number(utilizationAfter.toFixed(1)),
        });
      }

      const suggestions = days
        .filter((d) => d.fits)
        .sort((a, b) => {
          if (b.freeHoursAfter !== a.freeHoursAfter) {
            return b.freeHoursAfter - a.freeHoursAfter;
          }
          return a.date.localeCompare(b.date);
        })
        .slice(0, 3);

      sendJson(res, 200, {
        summary: {
          capacityHours,
          selectedTaskCount: selectedTasks.length,
          selectedHours: Number(selectedHours.toFixed(2)),
        },
        suggestions,
        days,
        selectedTasks: selectedTasks.map(mapTask),
      });
      return;
    }

    if (pathname === "/api/tasks/push-week" && method === "POST") {
      const body = await readJsonBody(req);
      const taskIds = Array.isArray(body.taskIds) ? body.taskIds : [];
      const shiftDays = Number(body.shiftDays || 7);
      if (!taskIds.length) {
        sendJson(res, 400, { error: "taskIds is required" });
        return;
      }

      const tasks = await getTasksByIds(taskIds);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const results = [];

      for (const taskId of taskIds) {
        const task = byId.get(taskId);
        if (!task) {
          results.push({
            taskId,
            ok: false,
            error: "Task not found",
          });
          continue;
        }

        try {
          const movedTo = await moveTask(task, { shiftDays });
          const fromDue = taskDueDate(task);
          appendLog({
            action: "push_week",
            taskId: task.id,
            title: task.title,
            fromDue,
            toDue: movedTo.due,
          });
          results.push({
            taskId: task.id,
            ok: true,
            title: task.title,
            fromDue,
            toDue: movedTo.due,
          });
        } catch (error) {
          results.push({
            taskId: task.id,
            ok: false,
            title: task.title,
            error: error.message,
          });
        }
      }

      sendJson(res, 200, {
        ok: true,
        total: results.length,
        successCount: results.filter((r) => r.ok).length,
        failedCount: results.filter((r) => !r.ok).length,
        results,
      });
      return;
    }

    if (pathname === "/api/tasks/labels" && method === "POST") {
      const body = await readJsonBody(req);
      const taskIds = Array.isArray(body.taskIds) ? body.taskIds : [];
      const labelKey = String(body.labelKey || "");
      if (!taskIds.length || !labelKey) {
        sendJson(res, 400, { error: "taskIds and labelKey are required" });
        return;
      }

      if (labelKey !== "prio" && labelKey !== "remove" && labelKey !== "clear") {
        sendJson(res, 400, {
          error: "Unsupported labelKey. Use prio, remove or clear.",
        });
        return;
      }

      const targetImportance =
        labelKey === "prio" ? "High" : labelKey === "remove" ? "Low" : "Normal";
      const tasks = await getTasksByIds(taskIds);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const results = [];

      for (const taskId of taskIds) {
        const task = byId.get(taskId);
        if (!task) {
          results.push({ taskId, ok: false, error: "Task not found" });
          continue;
        }

        const fromImportance = task.importance || "Normal";
        try {
          await wrikePut(`/tasks/${task.id}`, { importance: targetImportance });
          appendLog({
            action:
              labelKey === "prio"
                ? "mark_prio"
                : labelKey === "remove"
                  ? "mark_remove"
                  : "clear_label",
            taskId: task.id,
            title: task.title,
            fromImportance,
            toImportance: targetImportance,
          });
          results.push({
            taskId: task.id,
            ok: true,
            title: task.title,
            fromImportance,
            toImportance: targetImportance,
          });
        } catch (error) {
          results.push({
            taskId: task.id,
            ok: false,
            title: task.title,
            error: error.message,
          });
        }
      }

      sendJson(res, 200, {
        ok: true,
        labelKey,
        total: results.length,
        successCount: results.filter((r) => r.ok).length,
        failedCount: results.filter((r) => !r.ok).length,
        results,
      });
      return;
    }

    if (pathname === "/api/tasks/schedule" && method === "POST") {
      const body = await readJsonBody(req);
      const taskIds = Array.isArray(body.taskIds) ? body.taskIds : [];
      const targetDate = body.targetDate;
      if (!taskIds.length || !targetDate) {
        sendJson(res, 400, { error: "taskIds and targetDate are required" });
        return;
      }

      const tasks = await getTasksByIds(taskIds);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const results = [];

      for (const taskId of taskIds) {
        const task = byId.get(taskId);
        if (!task) {
          results.push({ taskId, ok: false, error: "Task not found" });
          continue;
        }
        try {
          const movedTo = await moveTask(task, { targetDate });
          const fromDue = taskDueDate(task);
          appendLog({
            action: "schedule",
            taskId: task.id,
            title: task.title,
            fromDue,
            toDue: movedTo.due,
          });
          results.push({
            taskId: task.id,
            ok: true,
            title: task.title,
            fromDue,
            toDue: movedTo.due,
          });
        } catch (error) {
          results.push({
            taskId: task.id,
            ok: false,
            title: task.title,
            error: error.message,
          });
        }
      }

      sendJson(res, 200, {
        ok: true,
        total: results.length,
        successCount: results.filter((r) => r.ok).length,
        failedCount: results.filter((r) => !r.ok).length,
        results,
      });
      return;
    }

    if (pathname === "/api/tasks/delete" && method === "POST") {
      const body = await readJsonBody(req);
      const taskIds = Array.isArray(body.taskIds) ? body.taskIds : [];
      if (!taskIds.length) {
        sendJson(res, 400, { error: "taskIds is required" });
        return;
      }

      const tasks = await getTasksByIds(taskIds);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const results = [];

      for (const taskId of taskIds) {
        try {
          await deleteTask(taskId);
          const title = byId.get(taskId)?.title || taskId;
          appendLog({
            action: "delete",
            taskId,
            title,
          });
          results.push({ taskId, ok: true, title });
        } catch (error) {
          results.push({
            taskId,
            ok: false,
            title: byId.get(taskId)?.title || taskId,
            error: error.message,
          });
        }
      }

      sendJson(res, 200, {
        ok: true,
        total: results.length,
        successCount: results.filter((r) => r.ok).length,
        failedCount: results.filter((r) => !r.ok).length,
        results,
      });
      return;
    }

    if (pathname === "/api/tasks/cancel" && method === "POST") {
      const body = await readJsonBody(req);
      const taskIds = Array.isArray(body.taskIds) ? body.taskIds : [];
      const reason = String(body.reason || "").trim();
      if (!taskIds.length) {
        sendJson(res, 400, { error: "taskIds is required" });
        return;
      }
      if (!reason) {
        sendJson(res, 400, { error: "reason is required" });
        return;
      }

      const tasks = await getTasksByIds(taskIds);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const results = [];

      for (const taskId of taskIds) {
        const task = byId.get(taskId);
        if (!task) {
          results.push({ taskId, ok: false, error: "Task not found" });
          continue;
        }

        try {
          const canceledStatus = await cancelTaskWithComment(task, reason);
          appendLog({
            action: "cancel",
            taskId: task.id,
            title: task.title,
            status: canceledStatus,
          });
          results.push({
            taskId: task.id,
            ok: true,
            title: task.title,
            status: canceledStatus,
          });
        } catch (error) {
          results.push({
            taskId: task.id,
            ok: false,
            title: task.title,
            error: error.message,
          });
        }
      }

      sendJson(res, 200, {
        ok: true,
        total: results.length,
        successCount: results.filter((r) => r.ok).length,
        failedCount: results.filter((r) => !r.ok).length,
        results,
      });
      return;
    }

    if (pathname === "/" && method === "GET") {
      sendFile(res, path.join(PUBLIC_DIR, "index.html"));
      return;
    }

    if (pathname === "/management" && method === "GET") {
      sendFile(res, path.join(PUBLIC_DIR, "management.html"));
      return;
    }

    if (pathname.startsWith("/public/") && method === "GET") {
      const filePath = path.join(ROOT_DIR, pathname);
      sendFile(res, filePath);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Unknown server error" });
  }
});

function startServer() {
  server.listen(config.port, () => {
    console.log(`Wrike dashboard running on http://localhost:${config.port}`);
    console.log("Wrike secrets backend: process env / optional .env local file");
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { server, startServer };
