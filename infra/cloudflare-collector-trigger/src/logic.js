const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const DEFAULTS = {
  calendarUrl:
    "https://raw.githubusercontent.com/tai1729/cyclocross-data-collector/main/race_days.json",
  githubOwner: "tai1729",
  githubRepo: "cyclocross-data-collector",
  workflowFile: "collect.yml",
  dispatchRef: "main",
};

export function parseIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    throw new Error(`invalid race date: ${String(value)}`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`invalid race date: ${value}`);
  }

  return value;
}

export function getNextCalendarDay(value) {
  const date = new Date(`${parseIsoDate(value)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function buildCollectionDays(raceDays) {
  if (!Array.isArray(raceDays)) {
    throw new Error("race_days.json must contain an array");
  }

  const normalized = raceDays.map(parseIsoDate);
  return [
    ...new Set([
      ...normalized,
      ...normalized.map(getNextCalendarDay),
    ]),
  ].sort();
}

export function formatJstDate(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid scheduled time: ${String(timestamp)}`);
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

export function isDispatchEnabled(value) {
  return value === true || value === "true";
}

export function buildGithubApiUrl(env, suffix) {
  const owner = encodeURIComponent(env.GITHUB_OWNER ?? DEFAULTS.githubOwner);
  const repo = encodeURIComponent(env.GITHUB_REPO ?? DEFAULTS.githubRepo);
  return `https://api.github.com/repos/${owner}/${repo}${suffix}`;
}

export function buildWorkflowRunsUrl(env) {
  const workflow = encodeURIComponent(env.WORKFLOW_FILE ?? DEFAULTS.workflowFile);
  return buildGithubApiUrl(
    env,
    `/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=20`,
  );
}

export function buildDispatchUrl(env) {
  const workflow = encodeURIComponent(env.WORKFLOW_FILE ?? DEFAULTS.workflowFile);
  return buildGithubApiUrl(env, `/actions/workflows/${workflow}/dispatches`);
}

export function isRecentRun(run, observedAtMs, windowMs = 10 * 60 * 1000) {
  if (!run || typeof run.created_at !== "string") {
    return false;
  }

  const createdAtMs = Date.parse(run.created_at);
  return Number.isFinite(createdAtMs) && Math.abs(createdAtMs - observedAtMs) <= windowMs;
}
