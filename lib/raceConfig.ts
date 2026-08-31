import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface RaceEntry {
  raceId: string;
  meetDate: string;
}

const ROOT_DIR = path.join(import.meta.dirname, "..");
export const RACES_JSON_PATH = path.join(ROOT_DIR, "races.json");
export const KNOWN_MEETS_JSON_PATH = path.join(ROOT_DIR, "known_meets.json");
export const RACE_DAYS_JSON_PATH = path.join(ROOT_DIR, "race_days.json");

export function getJstDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;

  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function addDays(date: string, amount: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf-8")) as T;
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export async function loadRaceEntries(): Promise<RaceEntry[]> {
  const value = await readJson<unknown>(RACES_JSON_PATH);
  if (!Array.isArray(value)) {
    throw new Error("races.json は配列である必要があります。");
  }

  if (value.every((entry) => typeof entry === "string")) {
    throw new Error("races.json は旧形式です。RaceEntry[]へ移行してください。");
  }

  const entries = value.filter(
    (entry): entry is RaceEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as RaceEntry).raceId === "string" &&
      /^\d+$/.test((entry as RaceEntry).raceId) &&
      typeof (entry as RaceEntry).meetDate === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test((entry as RaceEntry).meetDate),
  );

  if (entries.length !== value.length) {
    throw new Error("races.json に不正なエントリがあります。");
  }

  return entries.sort(
    (a, b) => a.meetDate.localeCompare(b.meetDate) || a.raceId.localeCompare(b.raceId),
  );
}

export async function loadKnownMeets(): Promise<string[]> {
  if (!(await fileExists(KNOWN_MEETS_JSON_PATH))) return [];

  const value = await readJson<unknown>(KNOWN_MEETS_JSON_PATH);
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("known_meets.json は大会スラッグの配列である必要があります。");
  }

  return [...new Set(value)].sort();
}
