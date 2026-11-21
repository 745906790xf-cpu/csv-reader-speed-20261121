// Fast drop-in for csv-reader 1.0.0: run(input) returns {columns, rows, errors} for
// input {text, header}, reading the text once, left to right, under the same broken-row
// policy as the reference (see the competition rules): a leading U+FEFF is dropped; a
// record ends at LF or CRLF and a characterless line is no record; a stray CR outside
// quotes is dropped (stray_cr); a quoted field runs to its closing quote ("" is one
// quote, CRLF/CR inside read as LF), trailing junk is appended (quote_junk), and an
// unterminated quote becomes a literal quote re-read as unquoted (unterminated_quote);
// rows are padded (short_row) or cut (long_row) to the first record's width; each error
// is {code, line, row} with line the record's starting line and row its index in rows
// (null for the header).
//
// Speed: fields are cut out with String.slice between special characters instead of
// being built character by character, and the scan runs on char codes.

const COMMA = 44;
const LF = 10;
const CR = 13;
const QUOTE = 34;

// How a field ended.
const ENDED_COMMA = 0;
const ENDED_BREAK = 1;
const ENDED_END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `prefix` up to the next comma or line break; a CR
  // not followed by LF is dropped (stray_cr). Returns the field, how it ended, and how
  // many characters were kept.
  function readUnquoted(prefix) {
    let value = prefix;
    let added = 0;
    let seg = pos;
    while (pos < n) {
      const cIdx = text.indexOf(",", pos);
      const lIdx = text.indexOf("\n", pos);
      const bound = Math.min(cIdx === -1 ? n : cIdx, lIdx === -1 ? n : lIdx);
      const rRel = text.slice(pos, bound).indexOf("\r");
      if (rRel !== -1) {
        const m = pos + rRel;
        if (text.charCodeAt(m + 1) === LF) {
          value += text.slice(seg, m);
          added += m - seg;
          pos = m + 2;
          line += 1;
          return { value, ended: ENDED_BREAK, added };
        }
        value += text.slice(seg, m);
        added += m - seg;
        errors.push({ code: "stray_cr", line: recordLine, row: recordRow });
        pos = m + 1;
        seg = pos;
        continue;
      }
      if (cIdx === -1 && lIdx === -1) {
        value += text.slice(seg, n);
        added += n - seg;
        pos = n;
        return { value, ended: ENDED_END, added };
      }
      if (cIdx !== -1 && (lIdx === -1 || cIdx < lIdx)) {
        value += text.slice(seg, cIdx);
        added += cIdx - seg;
        pos = cIdx + 1;
        return { value, ended: ENDED_COMMA, added };
      }
      value += text.slice(seg, lIdx);
      added += lIdx - seg;
      pos = lIdx + 1;
      line += 1;
      return { value, ended: ENDED_BREAK, added };
    }
    return { value, ended: ENDED_END, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    const parts = [];
    let seg = pos;
    let closed = false;
    while (pos < n) {
      const q = text.indexOf('"', pos);
      const end = q === -1 ? n : q;
      // Count lines and turn each CR/CRLF into LF within [pos, end).
      let j = pos;
      while (j < end) {
        const segText = text.slice(j, end);
        const rRel = segText.indexOf("\r");
        const lRel = segText.indexOf("\n");
        if (rRel === -1 && lRel === -1) break;
        if (lRel !== -1 && (rRel === -1 || lRel < rRel)) {
          line += 1;
          j += lRel + 1;
          continue;
        }
        const m = j + rRel;
        parts.push(text.slice(seg, m), "\n");
        line += 1;
        j = text.charCodeAt(m + 1) === LF ? m + 2 : m + 1;
        seg = j;
      }
      if (q === -1) {
        pos = n;
        break;
      }
      if (text.charCodeAt(q + 1) === QUOTE) {
        parts.push(text.slice(seg, q), '"');
        pos = q + 2;
        seg = pos;
        continue;
      }
      parts.push(text.slice(seg, q));
      pos = q + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character and the text after it is
      // read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: "unterminated_quote", line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    const value = parts.join("");
    if (pos >= n) return { value, ended: ENDED_END };
    const c = text.charCodeAt(pos);
    if (c === COMMA) {
      pos += 1;
      return { value, ended: ENDED_COMMA };
    }
    if (c === LF) {
      pos += 1;
      line += 1;
      return { value, ended: ENDED_BREAK };
    }
    if (c === CR && text.charCodeAt(pos + 1) === LF) {
      pos += 2;
      line += 1;
      return { value, ended: ENDED_BREAK };
    }
    // What follows the closing quote is appended as it stands.
    const junk = readUnquoted(value);
    if (junk.added > 0) {
      errors.push({ code: "quote_junk", line: recordLine, row: recordRow });
    }
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = pos < n && text.charCodeAt(pos) === QUOTE;
      field = quoted ? readQuoted() : readUnquoted("");
      fields.push(field.value);
    } while (field.ended === ENDED_COMMA);

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === "" && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: "short_row", line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push("");
    } else if (fields.length > width) {
      errors.push({ code: "long_row", line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
