/**
 * "14:32.2" や "57:35" のような mm:ss(.s) 表記を秒数に変換する。
 * パースできない場合はnullを返す（DNF/DNS等の空セル向け）。
 */
export function parseClockToSec(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return null;

  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (Number.isNaN(minutes) || Number.isNaN(seconds)) return null;

  return Math.round((minutes * 60 + seconds) * 10) / 10;
}
