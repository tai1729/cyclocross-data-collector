import {
  buildCollectionDays,
  buildDispatchUrl,
  buildWorkflowRunsUrl,
  DEFAULTS,
  formatJstDate,
  isDispatchEnabled,
  isRecentRun,
} from "./logic.js";

const GITHUB_API_VERSION = "2022-11-28";
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

export class HttpStatusError extends Error {
  constructor(operation, status) {
    super(`${operation} failed with HTTP ${status}`);
    this.name = "HttpStatusError";
    this.operation = operation;
    this.status = status;
  }
}

export class RetryableRequestError extends Error {
  constructor(operation, cause) {
    super(`${operation} request failed`);
    this.name = "RetryableRequestError";
    this.operation = operation;
    this.cause = cause;
  }
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

function retryable(error) {
  if (error instanceof RetryableRequestError) {
    return true;
  }
  if (!(error instanceof HttpStatusError)) {
    return false;
  }
  return error.status === 429 || error.status >= 500;
}

export async function withRetry(
  operation,
  {
    attempts = MAX_ATTEMPTS,
    delayMs = RETRY_DELAY_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !retryable(error)) {
        throw error;
      }
      await sleep(delayMs * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}

async function readJson(response, operation) {
  if (!response.ok) {
    throw new HttpStatusError(operation, response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

function calendarUrl(env, scheduledTime) {
  const base = env.CALENDAR_URL ?? DEFAULTS.calendarUrl;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}trigger=${encodeURIComponent(String(scheduledTime))}`;
}

async function getCollectionDays(env, fetchImpl, scheduledTime) {
  let response;
  try {
    response = await fetchImpl(calendarUrl(env, scheduledTime), {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
  } catch (error) {
    throw new RetryableRequestError("calendar fetch", error);
  }
  const payload = await readJson(response, "calendar fetch");
  return buildCollectionDays(payload);
}

async function hasRecentDispatch(env, fetchImpl, token, observedAtMs) {
  let response;
  try {
    response = await fetchImpl(buildWorkflowRunsUrl(env), {
      headers: githubHeaders(token),
    });
  } catch (error) {
    throw new RetryableRequestError("workflow run lookup", error);
  }
  const payload = await readJson(response, "workflow run lookup");
  if (!payload || !Array.isArray(payload.workflow_runs)) {
    throw new Error("workflow run lookup returned an invalid payload");
  }

  return payload.workflow_runs.some((run) => isRecentRun(run, observedAtMs));
}

async function dispatchWorkflow(env, fetchImpl, token) {
  let response;
  try {
    response = await fetchImpl(buildDispatchUrl(env), {
      method: "POST",
      headers: {
        ...githubHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: env.DISPATCH_REF ?? DEFAULTS.dispatchRef }),
    });
  } catch (error) {
    throw new RetryableRequestError("workflow dispatch", error);
  }

  if (!response.ok) {
    throw new HttpStatusError("workflow dispatch", response.status);
  }
}

export async function runScheduledCollection({
  scheduledTime,
  observedAtMs = Date.now(),
  env,
  fetchImpl = fetch,
  logger = console,
  sleep,
}) {
  const jstDate = formatJstDate(scheduledTime);
  const collectionDays = await withRetry(
    () => getCollectionDays(env, fetchImpl, scheduledTime),
    { sleep },
  );

  if (!collectionDays.includes(jstDate)) {
    logger.log(JSON.stringify({ event: "skip", reason: "not_collection_day", jstDate }));
    return { action: "skip", jstDate };
  }

  if (!isDispatchEnabled(env.DISPATCH_ENABLED)) {
    logger.log(JSON.stringify({ event: "skip", reason: "dispatch_disabled", jstDate }));
    return { action: "disabled", jstDate };
  }

  const token = env.GITHUB_ACTIONS_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("GITHUB_ACTIONS_TOKEN is not configured");
  }

  const recent = await withRetry(
    () => hasRecentDispatch(env, fetchImpl, token, observedAtMs),
    { sleep },
  );
  if (recent) {
    logger.log(JSON.stringify({ event: "skip", reason: "recent_dispatch", jstDate }));
    return { action: "deduplicated", jstDate };
  }

  await withRetry(
    () => dispatchWorkflow(env, fetchImpl, token),
    { sleep },
  );
  logger.log(JSON.stringify({ event: "dispatch_accepted", jstDate }));
  return { action: "dispatch", jstDate };
}
