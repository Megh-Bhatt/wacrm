'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  Upload,
  FileText,
  AlertTriangle,
  CheckCircle2,
  RotateCcw,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { parseCsvTable } from '@/lib/csv/parse-csv';
import { isValidE164, normalizePhone } from '@/lib/whatsapp/phone-utils';
import type { CustomField } from '@/types';

/** Payload the parent consumes as `audience.csvContacts`. */
export interface CsvContactRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  /** Keyed by `custom_fields.id`. Used for template-variable resolution
   *  during the send; not persisted to `contact_custom_values`. */
  customValues?: Record<string, string>;
}

/** Built-in targets a CSV column can map to. `ignore` means "skip this column". */
type BuiltInTarget = 'ignore' | 'phone' | 'name' | 'email' | 'company';

/**
 * Column mapping value:
 *   - a built-in target string (`phone`, `name`, …), OR
 *   - `custom:<custom_field.id>` for a custom-field mapping.
 * String encoding keeps the `<select>` bindings trivial.
 */
type MappingValue = BuiltInTarget | `custom:${string}`;

interface CsvAudiencePanelProps {
  onChange: (rows: CsvContactRow[] | undefined) => void;
}

/** Excel-column-letter labels for the mapping table (A, B, …, AA). */
function colLabel(i: number): string {
  let n = i;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const PREVIEW_ROWS = 5;

/**
 * Heuristic: pre-populate the mapping select when a CSV header name
 * clearly matches a built-in target. Users can always override.
 */
function guessBuiltInTarget(header: string): BuiltInTarget {
  // Excel exports of multi-line header cells (e.g. "CONTACT NO. \n(OWNER)")
  // arrive with embedded whitespace and punctuation. Collapse everything to
  // a single lowercase space-separated form so a header called
  // "CONTACT NO.\n(OWNER)" matches the same rule as "contact no owner".
  const h = header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!h) return 'ignore';
  if (
    /(^| )(phone|mobile|whatsapp|msisdn|cell|cellphone|contact( no| number)?)( |$)/.test(
      h,
    )
  ) {
    return 'phone';
  }
  if (['name', 'full name', 'contact name', 'first name', 'person name', 'owner'].includes(h)) return 'name';
  if (['email', 'e mail', 'email address'].includes(h)) return 'email';
  if (['company', 'company name', 'organization', 'organisation', 'business'].includes(h)) return 'company';
  return 'ignore';
}

function guessCustomFieldTarget(
  header: string,
  fields: CustomField[],
): `custom:${string}` | null {
  const h = header.trim().toLowerCase();
  if (!h) return null;
  const match = fields.find((f) => f.field_name.trim().toLowerCase() === h);
  return match ? (`custom:${match.id}` as const) : null;
}

export function CsvAudiencePanel({ onChange }: CsvAudiencePanelProps) {
  const t = useTranslations('Broadcasts.wizard.selectAudience.csvPanel');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<MappingValue[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [parsing, setParsing] = useState(false);

  // Load custom fields once so mapping options include them.
  useEffect(() => {
    let cancelled = false;
    async function fetchFields() {
      setFieldsLoading(true);
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from('custom_fields')
          .select('*')
          .order('field_name');
        if (!cancelled) setCustomFields((data ?? []) as CustomField[]);
      } finally {
        if (!cancelled) setFieldsLoading(false);
      }
    }
    fetchFields();
    return () => {
      cancelled = true;
    };
  }, []);

  function reset(clearParent = true) {
    setFile(null);
    setHeaders([]);
    setRows([]);
    setMapping([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (clearParent) onChange(undefined);
  }

  async function handleFile(picked: File) {
    if (picked.size > MAX_FILE_BYTES) {
      toast.error(t('errorTooLarge'));
      return;
    }

    setParsing(true);
    try {
      const text = await picked.text();
      const parsed = parseCsvTable(text);

      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        toast.error(t('errorEmptyFile'));
        return;
      }

      setFile(picked);
      setHeaders(parsed.headers);
      setRows(parsed.rows);

      // Pre-populate mapping: prefer custom-field name matches first
      // (they're the user's own vocabulary), then fall back to built-ins.
      // Track used targets so we never suggest the same target twice.
      const used = new Set<MappingValue>();
      const initial: MappingValue[] = parsed.headers.map((h) => {
        const customGuess = guessCustomFieldTarget(h, customFields);
        if (customGuess && !used.has(customGuess)) {
          used.add(customGuess);
          return customGuess;
        }
        const builtIn = guessBuiltInTarget(h);
        if (builtIn !== 'ignore' && !used.has(builtIn)) {
          used.add(builtIn);
          return builtIn;
        }
        return 'ignore';
      });
      setMapping(initial);
    } catch {
      toast.error(t('errorParse'));
    } finally {
      setParsing(false);
    }
  }

  function updateMapping(colIndex: number, next: MappingValue) {
    setMapping((prev) => {
      const draft = [...prev];
      // Uniqueness for non-ignore targets: if this target is already
      // used by another column, flip that other column back to `ignore`.
      // Prevents two columns silently both claiming "phone".
      if (next !== 'ignore') {
        for (let i = 0; i < draft.length; i++) {
          if (i !== colIndex && draft[i] === next) draft[i] = 'ignore';
        }
      }
      draft[colIndex] = next;
      return draft;
    });
  }

  // ── Derive resolved rows + summary from mapping ────────────────────
  interface Summary {
    total: number;
    valid: number;
    noPhone: number;
    invalidPhone: number;
    duplicates: number;
    phoneMapped: boolean;
  }

  const { resolved, summary } = useMemo<{
    resolved: CsvContactRow[];
    summary: Summary;
  }>(() => {
    if (headers.length === 0 || rows.length === 0) {
      return {
        resolved: [],
        summary: {
          total: 0,
          valid: 0,
          noPhone: 0,
          invalidPhone: 0,
          duplicates: 0,
          phoneMapped: false,
        },
      };
    }

    const phoneCol = mapping.indexOf('phone');
    const nameCol = mapping.indexOf('name');
    const emailCol = mapping.indexOf('email');
    const companyCol = mapping.indexOf('company');
    const phoneMapped = phoneCol >= 0;

    if (!phoneMapped) {
      return {
        resolved: [],
        summary: {
          total: rows.length,
          valid: 0,
          noPhone: 0,
          invalidPhone: 0,
          duplicates: 0,
          phoneMapped: false,
        },
      };
    }

    // Column index → custom_field.id, for each column mapped as custom.
    const customCols: { colIndex: number; fieldId: string }[] = [];
    mapping.forEach((m, i) => {
      if (m.startsWith('custom:')) {
        customCols.push({ colIndex: i, fieldId: m.slice('custom:'.length) });
      }
    });

    const seen = new Set<string>();
    const out: CsvContactRow[] = [];
    let noPhone = 0;
    let invalidPhone = 0;
    let duplicates = 0;

    for (const row of rows) {
      const rawPhone = (row[phoneCol] ?? '').trim();
      if (!rawPhone) {
        noPhone++;
        continue;
      }
      if (!isValidE164(rawPhone)) {
        invalidPhone++;
        continue;
      }

      const dedupeKey = normalizePhone(rawPhone);
      if (seen.has(dedupeKey)) {
        duplicates++;
        continue;
      }
      seen.add(dedupeKey);

      const name = nameCol >= 0 ? (row[nameCol] ?? '').trim() : '';
      const email = emailCol >= 0 ? (row[emailCol] ?? '').trim() : '';
      const company = companyCol >= 0 ? (row[companyCol] ?? '').trim() : '';

      const customValues: Record<string, string> = {};
      for (const { colIndex, fieldId } of customCols) {
        const v = (row[colIndex] ?? '').trim();
        if (v) customValues[fieldId] = v;
      }

      out.push({
        phone: rawPhone,
        ...(name ? { name } : {}),
        ...(email ? { email } : {}),
        ...(company ? { company } : {}),
        ...(Object.keys(customValues).length > 0 ? { customValues } : {}),
      });
    }

    return {
      resolved: out,
      summary: {
        total: rows.length,
        valid: out.length,
        noPhone,
        invalidPhone,
        duplicates,
        phoneMapped: true,
      },
    };
  }, [headers, rows, mapping]);

  // Push resolved rows to the parent whenever they change. Guard with a
  // stable JSON compare so unrelated re-renders don't ping the parent.
  const lastPushedRef = useRef<string>('');
  useEffect(() => {
    const key = JSON.stringify(resolved);
    if (key === lastPushedRef.current) return;
    lastPushedRef.current = key;
    onChange(resolved.length > 0 ? resolved : undefined);
  }, [resolved, onChange]);

  const openPicker = useCallback(() => fileInputRef.current?.click(), []);

  const targetOptions = useMemo(
    () => [
      { value: 'ignore' as const, label: t('mapTo.ignore') },
      { value: 'phone' as const, label: t('mapTo.phone') },
      { value: 'name' as const, label: t('mapTo.name') },
      { value: 'email' as const, label: t('mapTo.email') },
      { value: 'company' as const, label: t('mapTo.company') },
    ],
    [t],
  );

  const preview = rows.slice(0, PREVIEW_ROWS);

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card/50 p-4">
      {/* Dropzone / file picker */}
      <div
        role="button"
        tabIndex={0}
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') openPicker();
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const dropped = e.dataTransfer.files?.[0];
          if (dropped) void handleFile(dropped);
        }}
        className={cn(
          'group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-5 transition-all',
          file
            ? 'border-primary/35 bg-primary/[0.04]'
            : 'border-border/80 bg-background/40 hover:border-primary/40 hover:bg-background/70',
        )}
      >
        {parsing ? (
          <Loader2 className="size-5 animate-spin text-primary" />
        ) : file ? (
          <>
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-primary/25">
              <FileText className="size-5 text-primary" />
            </div>
            <p
              className="max-w-full truncate px-2 text-sm font-medium text-foreground"
              title={file.name}
            >
              {file.name}
            </p>
            <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              {t('rowsFound', { count: rows.length })}
            </span>
          </>
        ) : (
          <>
            <div className="flex size-10 items-center justify-center rounded-lg bg-muted/80 ring-1 ring-border/80 transition-colors group-hover:bg-muted">
              <Upload className="size-5 text-muted-foreground group-hover:text-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">{t('dropOrClick')}</p>
            <p className="text-[11px] text-muted-foreground">{t('hint')}</p>
          </>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          if (picked) void handleFile(picked);
        }}
        className="hidden"
      />

      {file && (
        <>
          {/* Column mapping */}
          <div className="rounded-xl border border-border bg-background/40">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                {t('columnMapping')}
              </p>
              <button
                type="button"
                onClick={() => reset(true)}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <RotateCcw className="size-3" />
                {t('pickAgain')}
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                      {t('csvColumn')}
                    </th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                      {t('sample')}
                    </th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                      {t('mapTo.label')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {headers.map((h, i) => {
                    const sample = preview
                      .map((r) => r[i])
                      .find((v) => v && v.trim());
                    return (
                      <tr key={`${h}-${i}`} className="bg-card/40">
                        <td className="px-3 py-2 align-top">
                          <div className="flex flex-col">
                            <span className="font-medium text-foreground">
                              {h || `(${colLabel(i)})`}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {t('columnLetter', { letter: colLabel(i) })}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top text-muted-foreground">
                          <span
                            className="block max-w-[14rem] truncate font-mono text-[11px]"
                            title={sample ?? ''}
                          >
                            {sample?.trim() || '—'}
                          </span>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <select
                            value={mapping[i] ?? 'ignore'}
                            onChange={(e) =>
                              updateMapping(i, e.target.value as MappingValue)
                            }
                            className="h-8 w-full max-w-[14rem] rounded-md border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                          >
                            {targetOptions.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                            {customFields.length > 0 && (
                              <optgroup label={t('mapTo.customFieldGroup')}>
                                {customFields.map((f) => (
                                  <option key={f.id} value={`custom:${f.id}`}>
                                    {f.field_name}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {fieldsLoading && (
              <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                {t('loadingCustomFields')}
              </div>
            )}
          </div>

          {/* Preview */}
          {preview.length > 0 && (
            <div className="rounded-xl border border-border bg-background/40">
              <p className="border-b border-border px-3 py-2 text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                {t('preview', { count: preview.length, total: rows.length })}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[24rem] text-xs">
                  <thead>
                    <tr className="border-b border-border bg-background/60">
                      {headers.map((h, i) => (
                        <th
                          key={`${h}-${i}`}
                          className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground"
                        >
                          {h || `(${colLabel(i)})`}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/70">
                    {preview.map((r, i) => (
                      <tr key={i} className="bg-card/40">
                        {headers.map((_, ci) => (
                          <td
                            key={ci}
                            className="max-w-[12rem] truncate px-3 py-2 text-muted-foreground"
                            title={r[ci] ?? ''}
                          >
                            {r[ci] || '—'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Summary */}
          <div className="rounded-xl border border-border bg-background/40 p-3">
            {!summary.phoneMapped ? (
              <div className="flex items-start gap-2 text-xs text-amber-400">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{t('errorNoPhoneMapping')}</span>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <span className="inline-flex items-center gap-1.5 text-primary">
                  <CheckCircle2 className="size-3.5" />
                  {t('summary.valid', { count: summary.valid })}
                </span>
                {summary.noPhone > 0 && (
                  <span className="text-muted-foreground">
                    {t('summary.noPhone', { count: summary.noPhone })}
                  </span>
                )}
                {summary.invalidPhone > 0 && (
                  <span className="text-muted-foreground">
                    {t('summary.invalidPhone', { count: summary.invalidPhone })}
                  </span>
                )}
                {summary.duplicates > 0 && (
                  <span className="text-muted-foreground">
                    {t('summary.duplicates', { count: summary.duplicates })}
                  </span>
                )}
                <span className="ml-auto text-muted-foreground">
                  {t('summary.total', { count: summary.total })}
                </span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
