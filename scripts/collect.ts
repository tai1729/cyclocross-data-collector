import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseRaceHtml } from "../lib/parseRaceHtml.js";
import {
  addDays,
  fileExists,
  getJstDate,
  loadRaceEntries,
  type RaceEntry,
} from "../lib/raceConfig.js";

const DATA_DIR = path.join(import.meta.dirname, "..", "data");
const MAX_CONCURRENCY = 5;
const REFRESH_DAYS = 14;

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

async function shouldCollect(entry: RaceEntry, today: string): Promise<boolean> {
  if (entry.meetDate > today) return false;
  if (entry.meetDate >= addDays(today, -REFRESH_DAYS)) return true;

  return !(await fileExists(path.join(DATA_DIR, `race-${entry.raceId}.json`)));
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
  const raceEntries = await loadRaceEntries();
  const today = getJstDate();
  const targets: RaceEntry[] = [];

  for (const entry of raceEntries) {
    if (await shouldCollect(entry, today)) targets.push(entry);
  }

  if (targets.length === 0) {
    console.log("No race data requires collection.");
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
    console.warn(`[WARN] ${failures.length} collection(s) failed; successful data was saved.`);
  }
}

main();
