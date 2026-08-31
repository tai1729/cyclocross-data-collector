import * as cheerio from "cheerio";
import {
  KNOWN_MEETS_JSON_PATH,
  RACES_JSON_PATH,
  addDays,
  getJstDate,
  loadKnownMeets,
  loadRaceEntries,
  writeJson,
  type RaceEntry,
} from "../lib/raceConfig.js";

const MEET_LIST_URL = "https://data.cyclocross.jp/meet";
const MAX_CONCURRENCY = 5;
const DISCOVERY_WINDOW_DAYS = 60;

interface MeetCandidate {
  slug: string;
  meetDate: string;
}

function parseDate(text: string): string | null {
  const match = text.trim().match(/(\d{4})-(\d{2})-(\d{2})/);
  return match ? match[0] : null;
}

function extractRaceId(url: string): string | null {
  const match = url.match(/\/race\/(\d+)/);
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

async function findRaceEntries(candidate: MeetCandidate): Promise<RaceEntry[]> {
  const { html, url } = await fetchText(
    `https://data.cyclocross.jp/meet/${candidate.slug}`,
  );
  const $ = cheerio.load(html);
  const raceIds = new Set<string>();

  const redirectedRaceId = extractRaceId(url);
  if (redirectedRaceId) raceIds.add(redirectedRaceId);

  $("#cat_tab a[href*='/race/']").each((_, element) => {
    const raceId = extractRaceId($(element).attr("href") ?? "");
    if (raceId) raceIds.add(raceId);
  });

  if (raceIds.size === 0) {
    throw new Error(`${candidate.slug}: カテゴリー別レースを取得できませんでした。`);
  }

  return [...raceIds].sort().map((raceId) => ({
    raceId,
    meetDate: candidate.meetDate,
  }));
}

async function runWithConcurrency<T>(
  entries: T[],
  worker: (entry: T) => Promise<void>,
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
  const today = getJstDate();
  const windowStart = addDays(today, -DISCOVERY_WINDOW_DAYS);
  const windowEnd = addDays(today, DISCOVERY_WINDOW_DAYS);
  const knownMeets = new Set(await loadKnownMeets());
  const existingRaces = await loadRaceEntries();

  const { html } = await fetchText(MEET_LIST_URL);
  const $ = cheerio.load(html);
  const candidates = new Map<string, MeetCandidate>();

  $("td.resuts_race a[href*='/meet/']").each((_, element) => {
    const slug = ($(element).attr("href") ?? "").match(/\/meet\/([^/?#]+)/)?.[1];
    const meetDate = parseDate(
      $(element).closest("tr").find("td.resuts_date").text(),
    );
    if (
      slug &&
      meetDate &&
      !knownMeets.has(slug) &&
      meetDate >= windowStart &&
      meetDate <= windowEnd
    ) {
      candidates.set(slug, { slug, meetDate });
    }
  });

  const discovered: RaceEntry[] = [];
  await runWithConcurrency([...candidates.values()], async (candidate) => {
    try {
      const entries = await findRaceEntries(candidate);
      discovered.push(...entries);
      knownMeets.add(candidate.slug);
      console.log(`[OK] ${candidate.slug}: ${entries.length}カテゴリーを発見`);
    } catch (error) {
      console.error("[FAILED]", error);
    }
  });

  const raceMap = new Map(existingRaces.map((entry) => [entry.raceId, entry]));
  for (const entry of discovered) raceMap.set(entry.raceId, entry);

  const races = [...raceMap.values()].sort(
    (a, b) =>
      a.meetDate.localeCompare(b.meetDate) || a.raceId.localeCompare(b.raceId),
  );
  await writeJson(RACES_JSON_PATH, races);
  await writeJson(KNOWN_MEETS_JSON_PATH, [...knownMeets].sort());

  console.log(`[OK] 新規レース ${discovered.length}件。収集対象は合計${races.length}件です。`);
}

main();
