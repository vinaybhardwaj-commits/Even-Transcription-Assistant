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
 * first textual occurrence, so a comment that quotes a constraint would answer for the real one:
 * document a clause in the header, narrow the real clause later, and the drift between them is restored
 * with the guard green (ETA-Refuter's F1 and G2 mutations, 23 Sep). Neither edit looks reckless, and
 * they need not be the same person.
 *
 * BOTH SYNTAXES, because stripping only one leaves the same hole in the other. `--` to end of line, and
 * `/* … *\/` including NESTED blocks, which Postgres supports and this repo writes (0074 uses `/** … *\/`
 * doc comments). To be clear about what is NOT claimed: this is a test helper reading migration files,
 * not a SQL parser. Dollar-quoted bodies ($$ … $$) are not treated as strings, so a comment marker
 * inside one is still stripped; no migration's CHECK lives inside a dollar-quoted body, and a CHECK that
 * did would need this to grow.
 */

/**
 * PURE — SQL with its comments removed: `--` to end of line, and `/* … *\/` blocks including nested
 * ones. A marker inside a single-quoted string is not a comment ('a -- b' and 'a /* b' survive intact).
 * Whole-line and trailing comments both go, and newlines are preserved so the result still lines up
 * with the file.
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
    if (c === "/" && sql[i + 1] === "*") {
      // Nested, as Postgres reads them: /* /* */ */ closes once, not twice. Newlines are kept so the
      // stripped text still lines up with the file.
      let depth = 1;
      i += 2;
      for (; i < sql.length && depth > 0; i++) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i++; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i++; }
        else if (sql[i] === "\n") out += "\n";
      }
      i--; // the loop's own i++ consumes the character after the close
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
