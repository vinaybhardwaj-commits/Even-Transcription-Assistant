/**
 * tests/support/sql-check.ts — read the VALUES out of a migration's CHECK constraint, so a test can
 * compare them against the code's own exported list instead of against a regex over the file's layout.
 *
 * WHY THIS EXISTS. A TypeScript union and a SQL CHECK are the same rule written twice, and they drift:
 * the E-5 store admitted two close reasons while the smoother returned five, and nothing failed
 * (ETA-Refuter, 23 Sep). A value-set comparison catches that in either direction and survives a
 * reformat of the list, which a verbatim regex does not.
 *
 * COMMENTS ARE STRIPPED FIRST, AND THAT IS THE LOAD-BEARING PART. The parser finds a constraint by its
 * first textual occurrence, and this house writes migration headers that QUOTE the constraint they are
 * documenting (0113 and 0115 both do). Handed the raw file, the guard reads the comment and never sees
 * the real CHECK — so someone documenting a constraint, and someone else later narrowing it, silently
 * restore the drift between them (ETA-Refuter's F1 mutation, 23 Sep). Neither edit looks reckless.
 */

/**
 * PURE — SQL with its `--` comments removed, to end of line, ignoring `--` inside a single-quoted
 * string. Whole-line and trailing comments both go; line structure is preserved so offsets stay readable.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (inString) {
      out += c;
      if (c === "'") {
        if (sql[i + 1] === "'") { out += sql[++i]!; continue; } // '' escape
        inString = false;
      }
      continue;
    }
    if (c === "'") { inString = true; out += c; continue; }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

/** The content of the balanced parentheses that start at or after `from`. */
function balanced(text: string, from: number): { body: string; end: number } {
  const open = text.indexOf("(", from);
  if (open < 0) throw new Error("no opening parenthesis");
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return { body: text.slice(open + 1, i), end: i };
  }
  throw new Error("unbalanced parentheses");
}

/**
 * The values of `<column> IN (...)` inside the named CHECK constraint, as a set. Comments are stripped
 * first, so a comment quoting the constraint cannot answer for it. Throws — loudly, naming what is
 * missing — when the constraint, the column's IN list, or a value is absent: a drift guard that
 * silently matches nothing is worse than no guard.
 */
export function checkValues(rawSql: string, constraint: string, column: string): Set<string> {
  const sql = stripSqlComments(rawSql);
  const at = sql.indexOf(`CONSTRAINT ${constraint} CHECK`);
  if (at < 0) throw new Error(`no CONSTRAINT ${constraint} in the migration`);
  const check = balanced(sql, at);
  const m = new RegExp(`${column}\\s+IN\\s*\\(`).exec(check.body);
  if (!m) throw new Error(`no ${column} IN (...) inside ${constraint}`);
  const list = balanced(check.body, m.index + m[0].length - 1);
  const values = list.body.split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
  if (values.some((v) => !v)) throw new Error(`empty value in ${column} IN list`);
  return new Set(values);
}
