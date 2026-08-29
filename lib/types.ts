export type DataQuality = "ok" | "error";

/**
 * "finished": 完走。 "dnf":途中棄権（部分的なラップデータを持つ）。
 * DNS（欠場）は取得元に記録が無いためriders配列に含めない。
 */
export type RiderStatus = "finished" | "dnf";

export interface LapRecord {
  lapNumber: number;
  lapTimeSec: number;
  cumulativeTimeSec: number;
  rankAtLap: number;
}

export interface Rider {
  riderId: string;
  name: string;
  /**
   * DNF選手には完走者の後ろに連番を割り当てる
   * （例: 完走33名ならDNF1人目は34、2人目は35）。
   */
  finalPosition: number;
  status: RiderStatus;
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
