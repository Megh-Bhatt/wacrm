/**
 * Generic CSV parsing utilities.
 *
 * Shared by the contacts import flow (`src/lib/contacts/parse-contact-csv.ts`)
 * and the broadcast-wizard CSV audience panel — one splitter, one place to
 * fix quoting bugs.
 *
 * Supports:
 *   - `\r\n` and `\n` line endings
 *   - a leading UTF-8 BOM (Excel exports produce one)
 *   - quoted fields with embedded commas
 *   - RFC-4180 escaped double quotes (`""` inside a quoted field → `"`)
 *   - embedded newlines inside a quoted field (Excel/Sheets exports of
 *     multi-line cells like "AMBRISH PANDYA\nCHAITALI PANDYA" and even
 *     multi-line headers like "CONTACT NO. \n(OWNER)")
 */

/**
 * Split a single CSV line into cell strings.
 *
 * @example
 *   parseCsvLine('a,"b,c","he said ""hi"""')  // → ['a', 'b,c', 'he said "hi"']
 */
export function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      // RFC 4180: a `""` inside a quoted field is a literal quote.
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
}

export interface ParsedCsvTable {
  /** Header cells, trimmed (empty string if that column had no header). */
  headers: string[];
  /**
   * Data rows. Each row is left-aligned against `headers`; short rows are
   * padded with `''` and long rows are truncated so `row.length === headers.length`
   * always holds. This lets callers index cells safely by column position.
   */
  rows: string[][];
}

/**
 * Parse a raw CSV blob into headers + rows without imposing any schema.
 *
 * Callers (the contacts-import parser and the broadcast column-mapping panel)
 * decide what each column means; this function does not know about phone,
 * name, or any other field.
 */
export function parseCsvTable(text: string): ParsedCsvTable {
  // Excel exports commonly begin with a UTF-8 BOM. Strip it once at the
  // top rather than inside the scanner — otherwise the first header
  // silently comes back as `﻿phone` and every mapping-by-name fails.
  const stripped = text.replace(/^﻿/, '');

  // Character-level scanner. Splitting on `\r?\n` first would break
  // real-world exports where a quoted cell spans lines — e.g.
  //   "AMBRISH PANDYA\nCHAITALI PANDYA"
  // or even a multi-line header like "CONTACT NO. \n(OWNER)". A newline
  // is a row separator only when we are NOT inside quotes.
  const allRows: string[][] = [];
  let current = '';
  let row: string[] = [];
  let inQuotes = false;

  const pushCell = () => {
    row.push(current.trim());
    current = '';
  };
  const pushRow = () => {
    pushCell();
    // Drop fully-blank rows (`,,,,`) — spreadsheet exports often add
    // trailing empty rows.
    if (!row.every((c) => c === '')) allRows.push(row);
    row = [];
  };

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];

    if (inQuotes) {
      if (ch === '"') {
        // RFC-4180: `""` inside quotes is a literal quote.
        if (stripped[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }

    // Not in quotes.
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushCell();
    } else if (ch === '\r') {
      // Swallow — the `\n` in \r\n handles the row break; a bare \r is rare.
    } else if (ch === '\n') {
      pushRow();
    } else {
      current += ch;
    }
  }
  // Flush the last row if the file did not end with a newline.
  if (current.length > 0 || row.length > 0) pushRow();

  if (allRows.length === 0) return { headers: [], rows: [] };

  const headers = allRows[0];
  const rows: string[][] = [];
  for (let i = 1; i < allRows.length; i++) {
    const cells = allRows[i];
    // Normalize width so callers can safely index by column position.
    if (cells.length < headers.length) {
      while (cells.length < headers.length) cells.push('');
    } else if (cells.length > headers.length) {
      cells.length = headers.length;
    }
    rows.push(cells);
  }

  return { headers, rows };
}
