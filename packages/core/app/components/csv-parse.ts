/**
 * Dependency-free CSV/TSV parsing for the table viewer. Owned (not a library)
 * so it stays small and unit-tested; handles RFC-4180 quoting: quoted fields
 * may contain the delimiter, escaped quotes (`""`), and embedded newlines.
 */

export interface ParsedCsv {
  /** All rows including the header; each cell already unquoted/unescaped. */
  rows: string[][];
  /** Widest row's column count — drives the table's grid. */
  maxColumns: number;
}

const SNIFF_CANDIDATES = [',', '\t', ';'] as const;

/**
 * Pick the delimiter. `.tsv` is always tab. Otherwise sniff the first few
 * non-empty lines and choose the candidate with the most consistent, highest
 * count, defaulting to comma.
 */
export function detectCsvDelimiter(filePath: string, content: string): string {
  if (filePath.toLowerCase().endsWith('.tsv')) return '\t';

  const lines = content.split(/\r\n|\r|\n/).filter((l) => l.length > 0).slice(0, 10);
  if (lines.length === 0) return ',';

  let best = ',';
  let bestScore = -1;
  for (const cand of SNIFF_CANDIDATES) {
    // Count occurrences outside quotes per line; reward a stable non-zero count.
    const counts = lines.map((l) => countOutsideQuotes(l, cand));
    const total = counts.reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    const first = counts[0];
    const consistent = counts.every((c) => c === first);
    const score = total + (consistent ? 100 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return best;
}

// Simplified quote tracking: a bare `"` toggles in/out. This miscounts escaped
// quotes (`""`) but is good enough for heuristic delimiter sniffing — it is NOT
// the real parser (see parseCsv, which handles `""` correctly).
function countOutsideQuotes(line: string, delim: string): number {
  let inQuotes = false;
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && ch === delim) {
      count += 1;
    }
  }
  return count;
}

/**
 * Parse CSV/TSV text into rows of cells. Trailing newline does not produce a
 * spurious empty row. An empty input yields no rows.
 */
export function parseCsv(content: string, delimiter: string): ParsedCsv {
  // Strip a leading UTF-8 BOM (common in Excel/Windows exports) so it doesn't
  // end up glued to the first header cell.
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let started = false; // whether the current row/field has any content yet

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true;
    } else if (ch === delimiter) {
      pushField();
      started = true;
    } else if (ch === '\n' || ch === '\r') {
      // Normalize CRLF: skip the \n following a \r.
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      pushRow();
    } else {
      field += ch;
      started = true;
    }
  }
  // Flush the final row unless the input ended exactly on a newline boundary
  // (no pending field/row content).
  if (started || field.length > 0 || row.length > 0) {
    pushRow();
  }

  let maxColumns = 0;
  for (const r of rows) maxColumns = Math.max(maxColumns, r.length);
  return { rows, maxColumns };
}
