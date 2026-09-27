/**
 * A small RFC 4180 CSV reader used to check uploads and collected outputs. It only splits text; it
 * never evaluates anything. Bounded by the caller (inputs are ≤ 10 MiB, outputs ≤ 5 MiB).
 */
export type CsvParse = { ok: true; rows: string[][] } | { ok: false; reason: string };

export function parseCsv(text: string, maxRows = 200_000): CsvParse {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const pushRow = () => {
    row.push(field);
    field = "";
    // A trailing blank line is not a row.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (field.length > 0) return { ok: false, reason: `row ${rows.length + 1}: quote inside an unquoted field` };
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      pushRow();
      if (rows.length > maxRows) return { ok: false, reason: `more than ${maxRows} rows` };
    } else field += ch;
    i += 1;
  }
  if (quoted) return { ok: false, reason: "unterminated quoted field" };
  if (field.length > 0 || row.length > 0) pushRow();
  if (rows.length === 0) return { ok: false, reason: "no rows" };
  const width = rows[0]!.length;
  const ragged = rows.findIndex((r) => r.length !== width);
  if (ragged >= 0) return { ok: false, reason: `row ${ragged + 1} has ${rows[ragged]!.length} fields; the header has ${width}` };
  return { ok: true, rows };
}
