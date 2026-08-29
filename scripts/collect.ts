import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseRaceHtml } from "../lib/parseRaceHtml.js";

const RACES_JSON_PATH = path.join(import.meta.dirname, "..", "races.json");
const DATA_DIR = path.join(import.meta.dirname, "..", "data");

async function loadRaceIds(): Promise<string[]> {
  const raw = await readFile(RACES_JSON_PATH, "utf-8");
  const raceIds: unknown = JSON.parse(raw);
  if (!Array.isArray(raceIds)) {
    throw new Error("races.json はレースIDの配列である必要があります");
  }
  return raceIds.map(String);
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

async function collectRace(raceId: string): Promise<void> {
  const html = await fetchRaceHtml(raceId);
  const race = parseRaceHtml(raceId, html);

  await mkdir(DATA_DIR, { recursive: true });
  const outPath = path.join(DATA_DIR, `race-${raceId}.json`);
  await writeFile(outPath, JSON.stringify(race, null, 2) + "\n", "utf-8");

  console.log(
    `[OK] race-${raceId}.json (${race.raceName} / ${race.category} / 選手${race.riders.length}名)`
  );
}

async function main() {
  const raceIds = await loadRaceIds();
  if (raceIds.length === 0) {
    console.log("races.json が空です。対象レースがありません。");
    return;
  }

  const results = await Promise.allSettled(raceIds.map((id) => collectRace(id)));

  const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  for (const failure of failures) {
    console.error("[FAILED]", failure.reason);
  }

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main();
