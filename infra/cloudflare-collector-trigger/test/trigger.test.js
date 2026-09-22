import assert from "node:assert/strict";
import test from "node:test";

import { buildCollectionDays, formatJstDate, formatJstSlot } from "../src/logic.js";
import { runScheduledCollection } from "../src/trigger.js";

const TARGET_TIME = Date.parse("2026-09-22T00:00:00.000Z");
const BASE_ENV = {
  CALENDAR_URL: "https://example.test/race_days.json",
  DISPATCH_ENABLED: "true",
  GITHUB_ACTIONS_TOKEN: "secret-token",
  GITHUB_OWNER: "tai1729",
  GITHUB_REPO: "cyclocross-data-collector",
  WORKFLOW_FILE: "collect.yml",
  DISPATCH_REF: "main",
};

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function makeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (!next) {
      throw new Error("unexpected fetch call");
    }
    return typeof next === "function" ? next(url, options) : next;
  };
  return { calls, fetchImpl };
}

function logger() {
  return { log() {}, error() {} };
}

test("formats scheduled time in JST", () => {
  assert.equal(formatJstDate(TARGET_TIME), "2026-09-22");
  assert.equal(formatJstSlot(TARGET_TIME), "2026-09-22T09:00+09:00");
});

test("covers race day and the following calendar day", () => {
  assert.deepEqual(buildCollectionDays(["2026-09-21"]), ["2026-09-21", "2026-09-22"]);
});

test("skips a non-covered date without calling GitHub", async () => {
  const { calls, fetchImpl } = makeFetch([response(["2026-10-01"])]);

  const result = await runScheduledCollection({
    scheduledTime: TARGET_TIME,
    env: { ...BASE_ENV, DISPATCH_ENABLED: "false" },
    fetchImpl,
    logger: logger(),
  });

  assert.equal(result.action, "skip");
  assert.equal(calls.length, 1);
});

test("does not dispatch while the activation flag is disabled", async () => {
  const { calls, fetchImpl } = makeFetch([response(["2026-09-22"])]);

  const result = await runScheduledCollection({
    scheduledTime: TARGET_TIME,
    env: { ...BASE_ENV, DISPATCH_ENABLED: "false", GITHUB_ACTIONS_TOKEN: undefined },
    fetchImpl,
    logger: logger(),
  });

  assert.equal(result.action, "disabled");
  assert.equal(calls.length, 1);
});

test("dispatches a covered date after the recent-run check", async () => {
  const { calls, fetchImpl } = makeFetch([
    response(["2026-09-22"]),
    response({ workflow_runs: [] }),
    response(null, 204),
  ]);

  const result = await runScheduledCollection({
    scheduledTime: TARGET_TIME,
    observedAtMs: TARGET_TIME + 60_000,
    env: BASE_ENV,
    fetchImpl,
    logger: logger(),
  });

  assert.equal(result.action, "dispatch");
  assert.equal(calls.length, 3);
  assert.equal(calls[2].options.method, "POST");
  assert.equal(calls[2].options.headers.Authorization, "Bearer secret-token");
  assert.equal(calls[2].options.headers["User-Agent"], "cyclocross-data-collector-trigger");
  assert.equal(calls[2].options.body, JSON.stringify({ ref: "main" }));
});

test("deduplicates a recent workflow dispatch", async () => {
  const { calls, fetchImpl } = makeFetch([
    response(["2026-09-22"]),
    response({ workflow_runs: [{ created_at: "2026-09-22T00:08:00.000Z" }] }),
  ]);

  const result = await runScheduledCollection({
    scheduledTime: TARGET_TIME,
    observedAtMs: TARGET_TIME + 120_000,
    env: BASE_ENV,
    fetchImpl,
    logger: logger(),
  });

  assert.equal(result.action, "deduplicated");
  assert.equal(calls.length, 2);
});

test("dispatches a later hourly slot instead of treating it as a duplicate", async () => {
  const nextHourlySlot = TARGET_TIME + 60 * 60 * 1000;
  const { calls, fetchImpl } = makeFetch([
    response(["2026-09-22"]),
    response({ workflow_runs: [{ created_at: "2026-09-22T00:00:00.000Z" }] }),
    response(null, 204),
  ]);

  const result = await runScheduledCollection({
    scheduledTime: nextHourlySlot,
    observedAtMs: nextHourlySlot,
    env: BASE_ENV,
    fetchImpl,
    logger: logger(),
  });

  assert.equal(result.action, "dispatch");
  assert.equal(result.jstSlot, "2026-09-22T10:00+09:00");
  assert.equal(calls.length, 3);
});

test("retries a transient dispatch failure", async () => {
  const { calls, fetchImpl } = makeFetch([
    response(["2026-09-22"]),
    response({ workflow_runs: [] }),
    response({ message: "temporary" }, 503),
    response(null, 204),
  ]);

  const result = await runScheduledCollection({
    scheduledTime: TARGET_TIME,
    env: BASE_ENV,
    fetchImpl,
    logger: logger(),
    sleep: async () => {},
  });

  assert.equal(result.action, "dispatch");
  assert.equal(calls.length, 4);
});

test("rejects an invalid calendar payload", async () => {
  const { fetchImpl } = makeFetch([response(["not-a-date"])]);

  await assert.rejects(
    runScheduledCollection({
      scheduledTime: TARGET_TIME,
      env: BASE_ENV,
      fetchImpl,
      logger: logger(),
    }),
    /invalid race date/,
  );
});

test("retries a transient calendar failure", async () => {
  const { calls, fetchImpl } = makeFetch([
    response({ message: "temporary" }, 503),
    response(["2026-10-01"]),
  ]);

  const result = await runScheduledCollection({
    scheduledTime: TARGET_TIME,
    env: { ...BASE_ENV, DISPATCH_ENABLED: "false" },
    fetchImpl,
    logger: logger(),
    sleep: async () => {},
  });

  assert.equal(result.action, "skip");
  assert.equal(calls.length, 2);
});
