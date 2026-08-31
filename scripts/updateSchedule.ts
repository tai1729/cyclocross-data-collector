import * as cheerio from "cheerio";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RACE_DAYS_JSON_PATH, writeJson } from "../lib/raceConfig.js";

const CALENDAR_URL = "https://www.cyclocross.jp/calendar/";
const COLLECT_WORKFLOW_PATH = path.join(
  import.meta.dirname,
  "..",
  ".github",
  "workflows",
  "collect.yml",
);
const SCHEDULE_START = "    # BEGIN GENERATED RACE SCHEDULE";
const SCHEDULE_END = "    # END GENERATED RACE SCHEDULE";

function parseCalendarDate(text: string): string | null {
  const match = text
    .replace(/\s+/g, " ")
    .match(/(\d{4})\s*\.?\s*(\d{1,2})\.(\d{1,2})/);
  if (!match) return null;

  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function buildScheduleLines(raceDays: string[]): string[] {
  return raceDays.map((raceDay) => {
    const [, month, day] = raceDay.split("-");
    return `    - cron: "0 9-23 ${Number(day)} ${Number(month)} *"\n      timezone: "Asia/Tokyo" # ${raceDay} JST`;
  });
}

function replaceGeneratedSchedule(workflow: string, raceDays: string[]): string {
  const start = workflow.indexOf(SCHEDULE_START);
  const end = workflow.indexOf(SCHEDULE_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("collect.yml に生成スケジュール用マーカーがありません。");
  }

  const lines = buildScheduleLines(raceDays);
  const replacement = [
    SCHEDULE_START,
    ...(lines.length > 0 ? lines : ["    # 開催日未登録のため定期実行なし"]),
    SCHEDULE_END,
  ].join("\n");

  return `${workflow.slice(0, start)}${replacement}${workflow.slice(
    end + SCHEDULE_END.length,
  )}`;
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
  const workflow = await readFile(COLLECT_WORKFLOW_PATH, "utf-8");
  await writeFile(
    COLLECT_WORKFLOW_PATH,
    replaceGeneratedSchedule(workflow, raceDays),
    "utf-8",
  );

  console.log(`[OK] ${raceDays.length}日分の開催日と収集スケジュールを更新しました。`);
}

main();
