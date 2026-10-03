import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { fetchCalendarHtml, parseCalendarDate } from "../scripts/updateSchedule.js";

test("parses the official calendar date text", () => {
  assert.equal(parseCalendarDate("2026. 9.21"), "2026-09-21");
  assert.equal(parseCalendarDate("開催日: 2026.10. 3"), "2026-10-03");
  assert.equal(parseCalendarDate("date unavailable"), null);
});

test("retries a transient calendar connection failure with backoff", async () => {
  const delays: number[] = [];
  let attempts = 0;
  const fetchImpl: typeof fetch = async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("fetch failed");
    return new Response("calendar html");
  };

  const html = await fetchCalendarHtml(
    fetchImpl,
    async (delayMs) => {
      delays.push(delayMs);
    },
    () => {},
  );

  assert.equal(html, "calendar html");
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [1_000]);
});

test("retries HTTP 429 and 5xx responses but not other client errors", async () => {
  for (const status of [429, 503]) {
    let serverAttempts = 0;
    const serverFetch: typeof fetch = async () => {
      serverAttempts += 1;
      return serverAttempts === 1
        ? new Response(null, { status })
        : new Response("calendar html");
    };

    assert.equal(
      await fetchCalendarHtml(serverFetch, async () => {}, () => {}),
      "calendar html",
    );
    assert.equal(serverAttempts, 2);
  }

  let clientAttempts = 0;
  const clientFetch: typeof fetch = async () => {
    clientAttempts += 1;
    return new Response(null, { status: 404 });
  };

  await assert.rejects(
    fetchCalendarHtml(clientFetch, async () => {}, () => {}),
    /calendar fetch failed: HTTP 404/,
  );
  assert.equal(clientAttempts, 1);
});

test("stops after three failed calendar requests", async () => {
  let attempts = 0;
  const fetchImpl: typeof fetch = async () => {
    attempts += 1;
    throw new TypeError("fetch failed");
  };
  const delays: number[] = [];

  await assert.rejects(
    fetchCalendarHtml(
      fetchImpl,
      async (delayMs) => {
        delays.push(delayMs);
      },
      () => {},
    ),
    /fetch failed/,
  );
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1_000, 2_000]);
});

test("the monthly updater does not rewrite the collection workflow", async () => {
  const source = await readFile(
    new URL("../scripts/updateSchedule.ts", import.meta.url),
    "utf8",
  );
  const workflow = await readFile(
    new URL("../.github/workflows/collect.yml", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /\.github[\\/]workflows[\\/]collect\.yml/);
  assert.doesNotMatch(workflow, /^  schedule:/m);
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /^  queue: max$/m);
});
