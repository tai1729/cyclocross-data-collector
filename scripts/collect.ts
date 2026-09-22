import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseRaceHtml } from "../lib/parseRaceHtml.js";
import { buildAndWriteArtifacts } from "./buildArtifacts.js";
import {
  addDays,
  getJstDate,
  MEETS_JSON_PATH,
  loadRaceEntries,
  readJson,
  isCanonicalSeason,
  type MeetEntry,
  type RaceEntry,
} from "../lib/raceConfig.js";
import { writeSiteMetadata } from "../lib/siteMetadata.js";

const DATA_DIR = path.join(import.meta.dirname, "..", "data");
const MAX_CONCURRENCY = 5;
const REFRESH_DAYS = 14;

export function getSeasonArgument(argv: readonly string[] = process.argv): string | null {
  const index = argv.indexOf("--season");
  if (index < 0) return null;

  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--") || value.trim() === "") {
    throw new Error("--season requires a non-empty YYYY-YY value");
  }
  return value;
}

function getArgumentValues(name: string): string[] {
  return process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1] ? [process.argv[index + 1]] : [],
  );
}

function getSeasonDateRange(season: string): { start: string; end: string } {
  const match = season.match(/^(\d{4})-(\d{2})$/);
  if (!match) throw new Error("--season は YYYY-YY 形式で指定してください。");
  const startYear = Number(match[1]);
  if (!isCanonicalSeason(season)) {
    throw new Error(`--season must use canonical YYYY-YY: ${season}`);
  }
  return { start: `${startYear}-07-01`, end: `${startYear + 1}-06-30` };
}

function isForceRequested(): boolean {
  return process.argv.includes("--force");
}

async function fetchRaceHtml(raceId: string): Promise<string> {
  const url = `https://data.cyclocross.jp/race/${raceId}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "cyclocross-data-collector (personal project)" },
  });
  if (!res.ok) {
    throw new Error(`fetch failed for race ${raceId}: HTTP ${res.status}`);
  }
  return res.text();
}

async function collectRace(entry: RaceEntry): Promise<void> {
  const html = await fetchRaceHtml(entry.raceId);
  const race = parseRaceHtml(entry.raceId, html);

  await mkdir(DATA_DIR, { recursive: true });
  const outPath = path.join(DATA_DIR, `race-${entry.raceId}.json`);
  await writeFile(outPath, `${JSON.stringify(race, null, 2)}\n`, "utf-8");

  console.log(
    `[OK] race-${entry.raceId}.json (${race.raceName} / ${race.category} / ${race.riders.length} riders)`,
  );
}

async function hasValidStoredRace(raceId: string): Promise<boolean> {
  try {
    const value = JSON.parse(
      await readFile(path.join(DATA_DIR, `race-${raceId}.json`), "utf-8"),
    ) as { raceId?: unknown; riders?: unknown };
    return value.raceId === raceId && Array.isArray(value.riders);
  } catch {
    return false;
  }
}

async function shouldCollect(entry: RaceEntry, today: string): Promise<boolean> {
  if (entry.meetDate > today) return false;
  if (entry.meetDate >= addDays(today, -REFRESH_DAYS)) return true;

  return !(await hasValidStoredRace(entry.raceId));
}

async function runWithConcurrency(
  entries: RaceEntry[],
  worker: (entry: RaceEntry) => Promise<void>,
): Promise<void> {
  const queue = [...entries];
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENCY, queue.length) },
    async () => {
      while (queue.length > 0) {
        const entry = queue.shift();
        if (entry) await worker(entry);
      }
    },
  );
  await Promise.all(workers);
}

async function main() {
  const force = isForceRequested();
  const season = getSeasonArgument();
  const meetIds = getArgumentValues("--meet");
  const seasonProvided = season !== null;
  const seasonRange = seasonProvided ? getSeasonDateRange(season) : null;
  const raceEntries = await loadRaceEntries();
  const today = getJstDate();
  if (seasonProvided && meetIds.length > 0) {
    throw new Error("--season と --meet は同時に指定できません。");
  }

  let forcedRaceIds: Set<string> | null = null;
  if (meetIds.length > 0) {
    const meets = await readJson<MeetEntry[]>(MEETS_JSON_PATH);
    const requested = new Set(meetIds);
    const found = meets.filter((meet) => requested.has(meet.meetId));
    const missing = meetIds.filter((meetId) => !found.some((meet) => meet.meetId === meetId));
    if (missing.length > 0) throw new Error(`大会が見つかりません: ${missing.join(", ")}`);
    forcedRaceIds = new Set(found.flatMap((meet) => meet.categories.map((category) => category.raceId)));
  }
  const targets: RaceEntry[] = [];

  for (const entry of raceEntries) {
    if (entry.meetDate > today) continue;
    if (forcedRaceIds?.has(entry.raceId)) {
      if (force || !(await hasValidStoredRace(entry.raceId))) targets.push(entry);
    } else if (
      seasonRange &&
      entry.meetDate >= seasonRange.start &&
      entry.meetDate <= seasonRange.end
    ) {
      if (force || !(await hasValidStoredRace(entry.raceId))) targets.push(entry);
    } else if (!forcedRaceIds && !seasonRange && (await shouldCollect(entry, today))) {
      targets.push(entry);
    }
  }

  if (targets.length === 0) {
    const artifacts = await buildAndWriteArtifacts();
    console.log(
      `No race data requires collection. Inventory: ${artifacts.counts.events} events / ${artifacts.counts.races} races.`,
    );
    if ((seasonProvided || meetIds.length > 0) && artifacts.failures.length > 0) {
      process.exitCode = 1;
      return;
    }
    await writeSiteMetadata();
    return;
  }

  const failures: unknown[] = [];
  await runWithConcurrency(targets, async (entry) => {
    try {
      await collectRace(entry);
    } catch (error) {
      failures.push(error);
      console.error("[FAILED]", error);
    }
  });

  if (failures.length > 0) {
    console.error(`[FAILED] ${failures.length} collection(s) failed; successful data was saved.`);
  }

  const artifacts = await buildAndWriteArtifacts();
  await writeSiteMetadata();
  console.log(
    `[OK] inventory: ${artifacts.counts.events} events / ${artifacts.counts.races} races / ${artifacts.counts.indexedRiders} riders`,
  );
  if ((seasonProvided || meetIds.length > 0) && (failures.length > 0 || artifacts.failures.length > 0)) {
    process.exitCode = 1;
  }
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
