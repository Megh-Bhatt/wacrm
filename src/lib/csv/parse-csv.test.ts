import { describe, expect, it } from 'vitest';
import { parseCsvLine, parseCsvTable } from './parse-csv';

describe('parseCsvLine', () => {
  it('splits a simple comma-separated line', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('keeps commas inside quoted fields', () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });

  it('unescapes RFC-4180 double-quotes inside quoted fields', () => {
    expect(parseCsvLine('a,"he said ""hi""",b')).toEqual([
      'a',
      'he said "hi"',
      'b',
    ]);
  });

  it('trims outer whitespace on each cell', () => {
    expect(parseCsvLine(' a , b , c ')).toEqual(['a', 'b', 'c']);
  });

  it('returns a single empty cell for an empty line', () => {
    expect(parseCsvLine('')).toEqual(['']);
  });
});

describe('parseCsvTable', () => {
  it('parses a basic CSV into headers and rows', () => {
    const csv = 'phone,name\n+15551234567,Alice\n+15559876543,Bob';
    expect(parseCsvTable(csv)).toEqual({
      headers: ['phone', 'name'],
      rows: [
        ['+15551234567', 'Alice'],
        ['+15559876543', 'Bob'],
      ],
    });
  });

  it('handles CRLF line endings', () => {
    const csv = 'a,b\r\n1,2\r\n3,4\r\n';
    expect(parseCsvTable(csv).rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('strips a leading UTF-8 BOM', () => {
    const csv = '﻿phone,name\n+15551234567,Alice';
    expect(parseCsvTable(csv).headers).toEqual(['phone', 'name']);
  });

  it('pads short rows to header width', () => {
    const csv = 'a,b,c\n1,2';
    expect(parseCsvTable(csv).rows).toEqual([['1', '2', '']]);
  });

  it('truncates long rows to header width', () => {
    const csv = 'a,b\n1,2,3,4';
    expect(parseCsvTable(csv).rows).toEqual([['1', '2']]);
  });

  it('drops fully-blank data rows', () => {
    const csv = 'a,b\n1,2\n,,\n\n3,4';
    expect(parseCsvTable(csv).rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('returns empty result for an empty file', () => {
    expect(parseCsvTable('')).toEqual({ headers: [], rows: [] });
  });

  it('returns headers with no rows for a header-only file', () => {
    expect(parseCsvTable('phone,name\n')).toEqual({
      headers: ['phone', 'name'],
      rows: [],
    });
  });

  it('preserves escaped quotes end-to-end', () => {
    const csv = 'name,note\nAlice,"say ""hi"""';
    expect(parseCsvTable(csv).rows).toEqual([['Alice', 'say "hi"']]);
  });

  it('keeps newlines inside a quoted cell together with the rest of its row', () => {
    // Real Excel export shape: a multi-line "PERSON NAME" cell wraps
    // AMBRISH + CHAITALI onto two lines but they belong to one CSV row.
    const csv =
      'company,person,phone\n' +
      'A K TRANSCHARGER,"AMBRISH PANDYA\nCHAITALI PANDYA",919725141557';
    const parsed = parseCsvTable(csv);
    expect(parsed.headers).toEqual(['company', 'person', 'phone']);
    expect(parsed.rows).toEqual([
      ['A K TRANSCHARGER', 'AMBRISH PANDYA\nCHAITALI PANDYA', '919725141557'],
    ]);
  });

  it('handles a multi-line header cell', () => {
    // Excel-exported header "CONTACT NO. \n(OWNER)" wraps to two lines
    // but is still one header cell.
    const csv = 'sr,"CONTACT NO. \n(OWNER)"\n1,919825172158';
    const parsed = parseCsvTable(csv);
    expect(parsed.headers).toEqual(['sr', 'CONTACT NO. \n(OWNER)']);
    expect(parsed.rows).toEqual([['1', '919825172158']]);
  });
});
