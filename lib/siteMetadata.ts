import { SITE_METADATA_JSON_PATH, writeJson } from "./raceConfig.js";

export interface SiteMetadata {
  updatedAt: string;
}

export function shouldPublishSiteMetadata(
  discoveredMeetCount: number,
  successfulCollectionCount: number,
): boolean {
  return discoveredMeetCount > 0 || successfulCollectionCount > 0;
}

export function createSiteMetadata(now: Date = new Date()): SiteMetadata {
  return { updatedAt: now.toISOString() };
}

export async function writeSiteMetadata(now: Date = new Date()): Promise<void> {
  await writeJson(SITE_METADATA_JSON_PATH, createSiteMetadata(now));
}
