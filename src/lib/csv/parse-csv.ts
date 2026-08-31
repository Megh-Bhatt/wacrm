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
 *
 * Does not support embedded newlines inside a quoted field. Neither did the
 * previous parser, and no caller relies on it; adding it would push us
 * toward a real dep (papaparse). Revisit only if a real user hits it.
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
  // top rather than inside the line splitter — otherwise the first header
  // silently comes back as `﻿phone` and every mapping-by-name fails.
  const stripped = text.replace(/^﻿/, '');

  const lines = stripped.split(/\r?\n/);

  // Trim trailing blank lines that most editors add.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = parseCsvLine(lines[0]);

  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    // Preserve original whitespace-only detection but skip fully-empty lines.
    if (lines[i].length === 0) continue;
    const cells = parseCsvLine(lines[i]);

    // Fully-blank rows (`,,,,`) are noise — drop them.
    if (cells.every((c) => c === '')) continue;

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
