import * as cheerio from "cheerio";
import { pathToFileURL } from "node:url";
import { RACE_DAYS_JSON_PATH, writeJson } from "../lib/raceConfig.js";

const CALENDAR_URL = "https://www.cyclocross.jp/calendar/";
const MAX_CALENDAR_FETCH_ATTEMPTS = 3;
const CALENDAR_FETCH_RETRY_DELAY_MS = 1_000;

class NonRetryableCalendarHttpError extends Error {}

export async function fetchCalendarHtml(
  fetchImpl: typeof fetch = fetch,
  sleep: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_CALENDAR_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetchImpl(CALENDAR_URL, {
        headers: { "User-Agent": "cyclocross-data-collector (personal project)" },
      });
      if (!res.ok) {
        const message = `calendar fetch failed: HTTP ${res.status}`;
        if (res.status !== 429 && res.status < 500) {
          throw new NonRetryableCalendarHttpError(message);
        }
        throw new Error(message);
      }

      return await res.text();
    } catch (error) {
      if (
        error instanceof NonRetryableCalendarHttpError ||
        attempt === MAX_CALENDAR_FETCH_ATTEMPTS
      ) {
        throw error;
      }

      const delayMs = CALENDAR_FETCH_RETRY_DELAY_MS * 2 ** (attempt - 1);
      const message = error instanceof Error ? error.message : String(error);
      warn(
        `[WARN] カレンダー取得に失敗しました (${attempt}/${MAX_CALENDAR_FETCH_ATTEMPTS}回目): ${message}。${delayMs}ms後に再試行します。`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error("calendar fetch failed after retries");
}

export function parseCalendarDate(text: string): string | null {
  const match = text
    .replace(/\s+/g, " ")
    .match(/(\d{4})\s*\.?\s*(\d{1,2})\s*\.\s*(\d{1,2})/);
  if (!match) return null;

  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

async function main() {
  const $ = cheerio.load(await fetchCalendarHtml());
  const raceDays = [
    ...new Set(
      $(".CL_raceDate")
        .toArray()
        .map((element) => parseCalendarDate($(element).text()))
        .filter((value): value is string => value !== null),
    ),
  ].sort();

  if (raceDays.length === 0) {
    throw new Error("カレンダーから開催日を取得できませんでした。");
  }

  await writeJson(RACE_DAYS_JSON_PATH, raceDays);

  console.log(`[OK] ${raceDays.length}日分の開催日を更新しました。`);
}

function isMainModule(): boolean {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
