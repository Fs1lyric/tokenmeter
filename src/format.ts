/**
 * Terminal formatting helpers. Kept dependency-free and colour-optional —
 * output is piped into scripts as often as it's read by a human.
 */

const useColor =
  process.stdout.isTTY === true &&
  process.env["NO_COLOR"] === undefined &&
  process.env["TERM"] !== "dumb";

const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = wrap("2");
export const bold = wrap("1");
export const green = wrap("32");
export const yellow = wrap("33");
export const cyan = wrap("36");

/**
 * Money, at a precision that matches the magnitude. Sub-cent amounts are the
 * common case for a single call, and rounding them to $0.00 makes the tool
 * look broken.
 */
export function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (max === 0) return SPARK[0]!.repeat(values.length);

  return values
    .map((v) => {
      const idx = Math.min(SPARK.length - 1, Math.round((v / max) * (SPARK.length - 1)));
      return SPARK[idx] ?? SPARK[0]!;
    })
    .join("");
}

export interface Column {
  header: string;
  align?: "left" | "right";
}

/** Minimal fixed-width table. Assumes no ANSI codes inside cell values. */
export function table(columns: Column[], rows: string[][]): string {
  const widths = columns.map((col, i) =>
    Math.max(col.header.length, ...rows.map((r) => (r[i] ?? "").length)),
  );

  const line = (cells: string[], style: (s: string) => string = (s) => s): string =>
    "  " +
    cells
      .map((cell, i) => {
        const width = widths[i] ?? 0;
        const align = columns[i]?.align ?? "left";
        return style(align === "right" ? cell.padStart(width) : cell.padEnd(width));
      })
      .join("  ")
      .trimEnd();

  const header = line(
    columns.map((c) => c.header),
    (s) => dim(s),
  );
  const body = rows.map((r) => line(r));

  return [header, ...body].join("\n");
}

/**
 * Parse a duration like `7d`, `24h`, `30m` into milliseconds.
 * Returns null for anything unrecognised so the caller can complain clearly.
 */
export function parseDuration(input: string): number | null {
  const match = /^(\d+)([smhdw])$/.exec(input.trim());
  if (!match) return null;

  const value = Number(match[1]);
  const unit = match[2];
  const scale: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };

  const factor = scale[unit ?? ""];
  return factor === undefined ? null : value * factor;
}
