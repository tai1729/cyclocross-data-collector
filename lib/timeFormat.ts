/**
 * "14:32.2" や "57:35" のような mm:ss(.s) 表記を秒数に変換する。
 * パースできない場合はnullを返す（DNF/DNS等の空セル向け）。
 */
export function parseClockToSec(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\d+):(?:(\d{2}):)?(\d+(?:\.\d+)?)$/);
  if (!match) return null;

  const firstUnit = Number(match[1]);
  const middleUnit = match[2] === undefined ? null : Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isFinite(firstUnit) || !Number.isFinite(seconds)) return null;
  if (middleUnit !== null && (!Number.isFinite(middleUnit) || middleUnit >= 60)) return null;
  if (seconds >= 60) return null;

  const totalSeconds = middleUnit === null
    ? firstUnit * 60 + seconds
    : firstUnit * 3600 + middleUnit * 60 + seconds;
  if (!Number.isFinite(totalSeconds)) return null;
  return Math.round(totalSeconds * 10) / 10;
}
