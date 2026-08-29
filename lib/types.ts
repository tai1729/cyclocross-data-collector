export type DataQuality = "ok" | "error";

export interface LapRecord {
  lapNumber: number;
  lapTimeSec: number;
  cumulativeTimeSec: number;
  rankAtLap: number;
}

export interface Rider {
  riderId: string;
  name: string;
  finalPosition: number;
  laps: LapRecord[];
  dataQuality: DataQuality;
}

export interface RaceResult {
  raceId: string;
  raceName: string;
  category: string;
  updatedAt: string;
  /**
   * このレースのカテゴリーで昇格した選手がいる場合のみ設定する
   * （昇格圏内の最下位の順位＝昇格ライン）。
   * 最上位カテゴリー（昇格先が存在しないカテゴリー）ではundefined。
   */
  promotionZoneRank?: number;
  riders: Rider[];
}
