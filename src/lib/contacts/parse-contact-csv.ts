/**
 * CSV parsing for the contacts import modal. Shared + unit-tested so
 * tag-column handling stays aligned with phone/name/email/company.
 *
 * The generic tokenizer lives in `src/lib/csv/parse-csv.ts` so the
 * broadcast wizard's column-mapping panel reuses the same splitter.
 * This module keeps its historical shape — headers hard-coded to the
 * import-modal contract (phone/name/email/company/tags).
 */

import { parseCsvTable } from '@/lib/csv/parse-csv';

export interface ParsedContactRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  /** Tag names from the optional `tags` column (comma/semicolon separated). */
  tagNames: string[];
}

/** Split a CSV cell into unique tag names (case-insensitive de-dupe). */
export function parseTagCell(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  const seen = new Set<string>();
  const names: string[] = [];

  for (const part of value.split(/[,;]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
}

export interface ParseContactCsvResult {
  rows: ParsedContactRow[];
  /** True when the CSV header includes a `tags` column. */
  hasTagsColumn: boolean;
  /** True when the CSV header includes a `company` column. */
  hasCompanyColumn: boolean;
}

function cleanCell(cell: string | undefined): string {
  // Legacy behavior: strip stray quotes/apostrophes that used to sneak
  // in when the tokenizer didn't understand escaped quotes.
  return cell?.replace(/["']/g, '').trim() ?? '';
}

export function parseContactCsv(text: string): ParseContactCsvResult {
  const { headers, rows } = parseCsvTable(text);

  if (headers.length === 0 || rows.length === 0) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };
  }

  const normalized = headers.map((h) => h.trim().toLowerCase().replace(/["']/g, ''));

  const phoneIdx = normalized.indexOf('phone');
  if (phoneIdx === -1) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };
  }

  const nameIdx = normalized.indexOf('name');
  const emailIdx = normalized.indexOf('email');
  const companyIdx = normalized.indexOf('company');
  const tagsIdx = normalized.indexOf('tags');

  const parsed: ParsedContactRow[] = [];
  for (const cells of rows) {
    const phone = cleanCell(cells[phoneIdx]);
    if (!phone) continue;

    parsed.push({
      phone,
      name: nameIdx >= 0 ? cleanCell(cells[nameIdx]) || undefined : undefined,
      email: emailIdx >= 0 ? cleanCell(cells[emailIdx]) || undefined : undefined,
      company:
        companyIdx >= 0 ? cleanCell(cells[companyIdx]) || undefined : undefined,
      tagNames: tagsIdx >= 0 ? parseTagCell(cleanCell(cells[tagsIdx])) : [],
    });
  }

  return {
    rows: parsed,
    hasTagsColumn: tagsIdx >= 0,
    hasCompanyColumn: companyIdx >= 0,
  };
}
