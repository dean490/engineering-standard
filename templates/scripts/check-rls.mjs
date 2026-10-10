#!/usr/bin/env node
// CI check "Row-level security on every exposed table" (STANDARD 4.1, 6.5):
// after the migrations replay into the local database, fail when a schema the
// Data API may expose holds
//   - a table (ordinary or partitioned) with row-level security disabled
//   - a view without security_invoker = true (it would run with its owner's
//     rights and bypass the row-level security of the tables it reads)
//   - a materialized view or foreign table that anon or authenticated can
//     select (neither can have row-level security)
// Objects an extension owns (such as PostGIS's spatial_ref_sys) don't count.
//
// The schemas checked are public and graphql_public always, plus any schema in
// supabase/config.toml [api] schemas, never fewer. The hosted project's exposed
// schemas are set in its own settings, not by this file, so a pull request
// can't narrow the check by editing it (and the Sensitive change check flags
// any change to it).
//
// Usage: node scripts/check-rls.mjs [--rows <file>]
//   Connects with psql to DB_URL, or to the local stack at
//   postgresql://postgres:postgres@127.0.0.1:<[db] port, default 54322>/postgres.
//   --rows <file> reads the query result from a file instead (one
//   "schema<TAB>name<TAB>relkind" line per finding), for testing.
// Part of the engineering standard; a protected path. No dependencies beyond psql.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const CONFIG = 'supabase/config.toml';
const ALWAYS = ['public', 'graphql_public'];

// The value of key in [section] of a TOML file: a string array or a number.
function tomlValue(text, section, key) {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/#.*$/, '').trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { inSection = header[1].trim() === section; continue; }
    if (!inSection) continue;
    const m = new RegExp(`^${key}\\s*=\\s*(.*)$`).exec(line);
    if (!m) continue;
    let value = m[1];
    while (value.startsWith('[') && !value.includes(']') && i + 1 < lines.length) {
      i += 1;
      value += lines[i].replace(/#.*$/, '').trim();
    }
    if (value.startsWith('[')) return [...value.matchAll(/"([^"]*)"|'([^']*)'/g)].map((x) => x[1] ?? x[2]);
    const n = Number(value);
    return Number.isFinite(n) ? n : value.replace(/^["']|["']$/g, '');
  }
  return undefined;
}

const config = existsSync(CONFIG) ? readFileSync(CONFIG, 'utf8') : '';
const configured = tomlValue(config, 'api', 'schemas');
const schemas = [...new Set([...ALWAYS, ...(Array.isArray(configured) ? configured : [])])];
for (const s of schemas) {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(s)) {
    console.error(`Unexpected schema name in ${CONFIG}: ${JSON.stringify(s)}`);
    process.exit(2);
  }
}

// Each role check runs only when the role exists, so the query also works on a
// database without Supabase's roles.
const selectableBy = (role) =>
  `case when exists (select 1 from pg_roles where rolname = '${role}') then has_any_column_privilege('${role}', c.oid, 'SELECT') else false end`;
const QUERY = `
select n.nspname, c.relname, c.relkind
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in (${schemas.map((s) => `'${s}'`).join(', ')})
  and not exists (
    select 1 from pg_depend d
    where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
  )
  and (
    (c.relkind in ('r', 'p') and not c.relrowsecurity)
    or (c.relkind = 'v' and not coalesce(
      (select o.option_value::boolean from pg_options_to_table(c.reloptions) o where o.option_name = 'security_invoker'),
      false))
    or (c.relkind in ('m', 'f') and (${selectableBy('anon')} or ${selectableBy('authenticated')}))
  )
order by 1, 2;`;

let rows;
const rowsArg = process.argv.indexOf('--rows');
if (rowsArg > 0) {
  rows = readFileSync(process.argv[rowsArg + 1], 'utf8');
} else {
  const port = tomlValue(config, 'db', 'port') ?? 54322;
  const url = process.env.DB_URL || `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  try {
    rows = execFileSync('psql', [url, '-X', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', QUERY], { encoding: 'utf8' });
  } catch (err) {
    console.error(`Could not query the database with psql (${err.message}). Is local Supabase running?`);
    process.exit(2);
  }
}

const WHAT = {
  r: 'row-level security disabled',
  p: 'row-level security disabled (partitioned table)',
  v: 'a view without security_invoker = true',
  m: 'a materialized view that anon or authenticated can select',
  f: 'a foreign table that anon or authenticated can select',
};
const findings = rows.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
  const [schema, name, kind = 'r'] = l.split('\t');
  return `${schema}.${name}: ${WHAT[kind] || `relkind ${kind}`}`;
});
if (findings.length) {
  console.log(`${findings.length} object(s) in schemas the Data API may expose (${schemas.join(', ')}) are not protected by row-level security:`);
  for (const f of findings) console.log(`- ${f}`);
  console.log('Fix it in a new migration: enable row-level security with policies and an isolation test, create views with (security_invoker = true), and revoke select on materialized views and foreign tables from anon and authenticated (STANDARD 4.1; .claude/rules/rls.md).');
  process.exit(1);
}
console.log(`Row-level security protects every table and view in ${schemas.join(', ')}.`);
