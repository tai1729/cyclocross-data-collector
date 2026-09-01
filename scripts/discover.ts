import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import {
  MEETS_JSON_PATH,
  KNOWN_MEETS_JSON_PATH,
  RACES_JSON_PATH,
  addDays,
  getJstDate,
  loadKnownMeets,
  loadRaceEntries,
  readJson,
  writeJson,
  type MeetEntry,
  type RaceEntry,
} from "../lib/raceConfig.js";

const MEET_LIST_URL = "https://data.cyclocross.jp/meet";
const MAX_CONCURRENCY = 5;
const DISCOVERY_WINDOW_DAYS = 60;

interface MeetCandidate {
  meetId: string;
  meetDate: string;
  series: string;
  meetName: string;
}

function parseDate(text: string): string | null {
  const match = text.trim().match(/(\d{4})-(\d{2})-(\d{2})/);
  return match ? match[0] : null;
}

function getSeason(meetDate: string): string {
  const year = Number(meetDate.slice(0, 4));
  const month = Number(meetDate.slice(5, 7));
  const startYear = month >= 7 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

function extractRaceId(url: string): string | null {
  const match = url.match(/\/race\/(\d+)/);
  return match ? match[1] : null;
}

function extractMeetId(url: string): string | null {
  const match = url.match(/\/meet\/([^/?#]+)/);
  return match ? match[1] : null;
}

async function fetchText(url: string): Promise<{ html: string; url: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": "cyclocross-data-collector (personal project)" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`fetch failed: ${url} (HTTP ${res.status})`);
  return { html: await res.text(), url: res.url };
}

function parseMeetCandidate($: cheerio.CheerioAPI, row: Element): MeetCandidate | null {
  const $row = $(row);
  const meetLink = $row.find("a[href*='/meet/']").first();
  const meetId = extractMeetId(meetLink.attr("href") ?? "");
  const meetDate = parseDate($row.find("td.resuts_date").text());
  if (!meetId || !meetDate) return null;

  const series = $row.find("td.results_area a").first().text().trim();
  const meetName = meetLink.text().trim() || $row.find("td.resuts_race").text().trim();

  return { meetId, meetDate, series, meetName };
}

async function findMeetEntry(candidate: MeetCandidate): Promise<MeetEntry> {
  const { html, url } = await fetchText(`${MEET_LIST_URL}/${candidate.meetId}`);
  const $ = cheerio.load(html);
  const categories: MeetEntry["categories"] = [];
  const seen = new Set<string>();

  const redirectedRaceId = extractRaceId(url);
  if (redirectedRaceId) {
    categories.push({ raceId: redirectedRaceId, name: $("#ec_name").text().trim(), order: 0 });
    seen.add(redirectedRaceId);
  }

  $("#cat_tab a[href*='/race/']").each((_, element) => {
    const raceId = extractRaceId($(element).attr("href") ?? "");
    if (!raceId || seen.has(raceId)) return;
    seen.add(raceId);
    categories.push({
      raceId,
      name: $(element).text().trim(),
      order: categories.length,
    });
  });

  if (categories.length === 0) {
    throw new Error(`${candidate.meetId}: カテゴリー別レースを取得できませんでした。`);
  }

  return {
    meetId: candidate.meetId,
    season: getSeason(candidate.meetDate),
    meetDate: candidate.meetDate,
    series: candidate.series,
    meetName: candidate.meetName,
    categories,
  };
}

async function runWithConcurrency<T>(entries: T[], worker: (entry: T) => Promise<void>): Promise<void> {
  const queue = [...entries];
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry) await worker(entry);
    }
  });
  await Promise.all(workers);
}

function getSeasonArgument(): string | null {
  const index = process.argv.indexOf("--season");
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function getDateRange(season: string | null): { start: string; end: string } {
  if (season) {
    const match = season.match(/^(\d{4})-(\d{2})$/);
    if (!match) throw new Error("--season は YYYY-YY 形式で指定してください。");
    const startYear = Number(match[1]);
    return { start: `${startYear}-07-01`, end: `${startYear + 1}-06-30` };
  }

  const today = getJstDate();
  return { start: addDays(today, -DISCOVERY_WINDOW_DAYS), end: addDays(today, DISCOVERY_WINDOW_DAYS) };
}

async function main() {
  const season = getSeasonArgument();
  const { start, end } = getDateRange(season);
  const knownMeets = new Set(await loadKnownMeets());
  const existingRaces = await loadRaceEntries();
  const existingMeets = await readJson<MeetEntry[]>(MEETS_JSON_PATH).catch(() => []);

  const { html } = await fetchText(MEET_LIST_URL);
  const $ = cheerio.load(html);
  const candidates = new Map<string, MeetCandidate>();

  $("td.resuts_race a[href*='/meet/']").each((_, element) => {
    const row = $(element).closest("tr").get(0);
    if (!row) return;
    const candidate = parseMeetCandidate($, row as Element);
    if (candidate && candidate.meetDate >= start && candidate.meetDate <= end && (!knownMeets.has(candidate.meetId) || season !== null)) {
      candidates.set(candidate.meetId, candidate);
    }
  });

  const discoveredMeets: MeetEntry[] = [];
  await runWithConcurrency([...candidates.values()], async (candidate) => {
    try {
      const meet = await findMeetEntry(candidate);
      discoveredMeets.push(meet);
      knownMeets.add(candidate.meetId);
      console.log(`[OK] ${candidate.meetId}: ${meet.categories.length}カテゴリーを発見`);
    } catch (error) {
      console.error("[FAILED]", error);
    }
  });

  const meetMap = new Map(existingMeets.map((meet) => [meet.meetId, meet]));
  for (const meet of discoveredMeets) meetMap.set(meet.meetId, meet);
  const meets = [...meetMap.values()].sort((a, b) => b.meetDate.localeCompare(a.meetDate));

  const raceMap = new Map(existingRaces.map((entry) => [entry.raceId, entry]));
  for (const meet of discoveredMeets) {
    for (const category of meet.categories) {
      raceMap.set(category.raceId, { raceId: category.raceId, meetDate: meet.meetDate });
    }
  }

  await writeJson(MEETS_JSON_PATH, meets);
  await writeJson(RACES_JSON_PATH, [...raceMap.values()].sort((a, b) => a.meetDate.localeCompare(b.meetDate) || a.raceId.localeCompare(b.raceId)));
  await writeJson(KNOWN_MEETS_JSON_PATH, [...knownMeets].sort());
  console.log(`[OK] 新規大会 ${discoveredMeets.length}件、一覧は合計${meets.length}件です。`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
