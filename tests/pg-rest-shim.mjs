// Minimal PostgREST-compatible shim for local testing.
//
// The production code talks to Supabase through PostgREST's HTTP contract:
//   GET/POST/PATCH/DELETE /rest/v1/<table>?<filters>
//   POST /rest/v1/rpc/<function>   { ...args }
//   Prefer: return=representation  -> return the affected rows as JSON
//
// This shim implements that contract against a local PostgreSQL database so the
// TEST SUITE exercises the real code path (real SQL functions, real atomicity)
// without needing Docker or the full Supabase stack.
//
// It is a TEST-ONLY artifact. Production talks to the real Supabase project.

import http from 'node:http';
import { Client } from 'pg';

const DB_URL = process.env.TEST_DATABASE_URL;
const PORT = Number.parseInt(process.env.TEST_PGREST_PORT || '55433', 10);
const API_KEY = 'test-service-role-key';
const ANON_KEY = 'test-anon-key';

if (!DB_URL) throw new Error('TEST_DATABASE_URL required');

const pool = new Client({ connectionString: DB_URL });
await pool.connect();

function json(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

function splitTop(s, sep) {
  const out = [];
  let depth = 0, cur = '', inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === '"' && s[i - 1] !== '\\') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur !== '') out.push(cur);
  return out;
}

function parseFilters(query) {
  const filters = [];
  const order = [];
  let limit = null;
  for (const [rawKey, rawVal] of Object.entries(query || {})) {
    if (rawKey === 'select') continue;
    if (rawKey === 'order') { order.push(rawVal); continue; }
    if (rawKey === 'limit') { limit = Number.parseInt(rawVal, 10); continue; }
    if (rawKey === 'offset') continue;
    const key = rawKey.replace(/^and_/, '');
    const m = /^([a-z_][a-z0-9_]*)\.([^.]+)\.(eq|neq|gt|gte|lt|lte|like|ilike|in|is)\.(.*)$/i.exec(key);
    if (!m) continue;
    const op = m[4].toLowerCase();
    let val = m[5];
    if (op === 'in') {
      val = '(' + val.replace(/^\(|\)$/g, '') + ')';
    } else if (op === 'is') {
      val = val.toLowerCase() === 'null' ? 'null' : 'not null';
    } else if (op !== 'ilike') {
      val = "'" + String(val).replace(/'/g, "''") + "'";
    }
    filters.push({ col: m[2], op, val });
  }
  return { filters, order, limit };
}

function buildWhere(filters) {
  if (!filters.length) return { sql: '', params: [] };
  const parts = [];
  const params = [];
  for (const f of filters) {
    if (f.op === 'in') {
      parts.push(`${f.col} = any(${f.val})`);
    } else if (f.op === 'is') {
      parts.push(`${f.col} is ${f.val}`);
    } else if (f.op === 'ilike') {
      parts.push(`${f.col} ilike ${f.val}`);
    } else {
      parts.push(`${f.col} ${f.op} ${f.val}`);
    }
  }
  return { sql: ' where ' + parts.join(' and '), params };
}

function buildOrder(order) {
  if (!order.length) return '';
  const bits = order.map((o) => {
    const desc = o.toLowerCase().endsWith('.desc');
    const col = o.replace(/\.(asc|desc)$/i, '');
    return `${col} ${desc ? 'desc' : 'asc'}`;
  });
  return ' order by ' + bits.join(', ');
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

function jsonbLiteral(v) {
  return JSON.stringify(v);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/rest/v1/')) {
      return json(res, 404, { message: 'not found' });
    }
    const auth = req.headers.authorization || '';
    if (!auth.includes(API_KEY) && !auth.includes(ANON_KEY)) {
      return json(res, 401, { message: 'invalid token' });
    }
    const rest = url.pathname.slice('/rest/v1/'.length);
    const body = await readBody(req);
    const query = Object.fromEntries(url.searchParams.entries());

    // ---------- RPC ----------
    if (rest.startsWith('rpc/')) {
      const fn = rest.slice(4);
      const args = body && typeof body === 'object' ? body : {};
      const keys = Object.keys(args);
      if (!keys.length) {
        return json(res, 400, { code: 'PGRST202', message: `no args for ${fn}` });
      }
      const placeholders = keys.map((k, i) => {
        const v = args[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) return `$${i + 1}::jsonb`;
        return `$${i + 1}`;
      });
      const params = keys.map((k) => {
        const v = args[k];
        if (v && typeof v === 'object') {
          // jsonb params are sent as JSON text and cast server-side
          return JSON.stringify(v);
        }
        return v;
      });
      const sql = `select * from public.${fn}(${placeholders.join(', ')})`;
      const r = await pool.query(sql, params);
      const wantRows = String(req.headers.prefer || '').includes('return=representation');
      if (r.rows.length === 0) {
        return json(res, wantRows ? 200 : 200, []);
      }
      // scalar-returning functions come back as one column
      const first = r.rows[0];
      const vals = Object.values(first);
      if (vals.length === 1 && vals[0] !== null && typeof vals[0] === 'object') {
        return json(res, 200, vals[0]);
      }
      if (vals.length === 1) {
        return json(res, 200, wantRows ? r.rows : vals[0]);
      }
      return json(res, 200, wantRows ? r.rows : vals);
    }

    // ---------- table ----------
    const table = rest.replace(/[^a-zA-Z0-9_]/g, '');
    if (!table) return json(res, 400, { message: 'bad table' });

    const { filters, order, limit } = parseFilters(query);
    const where = buildWhere(filters);
    const ord = buildOrder(order);
    const lim = limit ? ` limit ${limit}` : '';

    if (req.method === 'GET') {
      const select = (query.select || '*').replace(/[^a-zA-Z0-9_,* ]/g, '');
      const sql = `select ${select} from public.${table}${where.sql}${ord}${lim}`;
      const r = await pool.query(sql);
      return json(res, 200, r.rows);
    }

    if (req.method === 'POST') {
      const rows = Array.isArray(body) ? body : [body];
      const cols = Object.keys(rows[0]);
      const quoted = cols.map((c) => '"' + c + '"').join(', ');
      const values = [];
      const params = [];
      rows.forEach((row, ri) => {
        const ph = [];
        cols.forEach((c, ci) => {
          const v = row[c];
          if (v && typeof v === 'object') {
            ph.push(`$${params.length + 1}::jsonb`);
            params.push(jsonbLiteral(v));
          } else {
            ph.push(`$${params.length + 1}`);
            params.push(v === undefined ? null : v);
          }
        });
        values.push(`(${ph.join(', ')})`);
      });
      const onConflict = query.on_conflict
        ? ' on conflict (' + query.on_conflict.split(',').map((c) => '"' + c.trim() + '"').join(', ') + ') do nothing'
        : '';
      const returning = String(req.headers.prefer || '').includes('return=representation') ? ' returning *' : '';
      const sql = `insert into public.${table} (${quoted}) values ${values.join(', ')}${onConflict}${returning}`;
      try {
        const r = await pool.query(sql, params);
        return json(res, 201, String(req.headers.prefer || '').includes('return=representation') ? r.rows : []);
      } catch (e) {
        if (e.code === '23505') {
          // unique violation -> PostgREST reports 409
          return json(res, 409, { code: '23505', message: 'duplicate key value violates unique constraint' });
        }
        if (e.code === 'P0001') {
          return json(res, 400, { code: e.code, message: e.message, detail: e.detail });
        }
        return json(res, 400, { code: e.code || 'ERROR', message: e.message });
      }
    }

    if (req.method === 'PATCH') {
      const row = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
      const cols = Object.keys(row);
      if (!cols.length) return json(res, 400, { message: 'empty patch' });
      const sets = [];
      const params = [];
      cols.forEach((c) => {
        const v = row[c];
        if (v && typeof v === 'object') {
          sets.push(`"${c}" = $${params.length + 1}::jsonb`);
          params.push(jsonbLiteral(v));
        } else {
          sets.push(`"${c}" = $${params.length + 1}`);
          params.push(v === undefined ? null : v);
        }
      });
      const returning = String(req.headers.prefer || '').includes('return=representation') ? ' returning *' : '';
      const sql = `update public.${table} set ${sets.join(', ')}${where.sql}${returning}`;
      try {
        const r = await pool.query(sql, params);
        return json(res, 200, String(req.headers.prefer || '').includes('return=representation') ? r.rows : []);
      } catch (e) {
        return json(res, 400, { code: e.code || 'ERROR', message: e.message });
      }
    }

    if (req.method === 'DELETE') {
      const sql = `delete from public.${table}${where.sql}`;
      await pool.query(sql);
      return json(res, 200, []);
    }

    return json(res, 405, { message: 'method not allowed' });
  } catch (err) {
    return json(res, 500, { message: err.message, code: err.code });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[test-pgrest] listening on http://127.0.0.1:' + PORT);
});

export { server, pool };
