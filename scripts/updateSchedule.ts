import * as cheerio from "cheerio";
import { pathToFileURL } from "node:url";
import { RACE_DAYS_JSON_PATH, writeJson } from "../lib/raceConfig.js";

const CALENDAR_URL = "https://www.cyclocross.jp/calendar/";

export function parseCalendarDate(text: string): string | null {
  const match = text
    .replace(/\s+/g, " ")
    .match(/(\d{4})\s*\.?\s*(\d{1,2})\s*\.\s*(\d{1,2})/);
  if (!match) return null;

  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

async function main() {
  const res = await fetch(CALENDAR_URL, {
    headers: { "User-Agent": "cyclocross-data-collector (personal project)" },
  });
  if (!res.ok) {
    throw new Error(`calendar fetch failed: HTTP ${res.status}`);
  }

  const $ = cheerio.load(await res.text());
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
