// 白泽 · 后端 API · 单文件
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, createReadStream, statSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
const execP = promisify(exec);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===== Config =====
const PORT = +(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_IN_PROD_PLEASE';
const COOKIE_NAME = 'baize_token';
const SESSION_DAYS = 7;
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'baize.db');

const SEED_ADMIN = {
  username: '13325905201',
  password: '@HyZ20041210520166',
  role: 'admin',
};
const SEED_USERS = [
  { username: 'xuesheng', password: '1234567890', role: 'student' },
  { username: 'jiaoshi',  password: '1234567890', role: 'teacher' },
  { username: 'qiye',     password: '1234567890', role: 'enterprise' },
];

// ===== Database =====
mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('student','teacher','enterprise','admin')),
  blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('chat','image')),
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS api_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('llm','image')),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_configs_kind ON api_configs(kind);

CREATE TABLE IF NOT EXISTS schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  payload TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_schedule_user_date ON schedule(user_id, date);

CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  tag TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publisher_id INTEGER,
  publisher_name TEXT,
  claimer_id INTEGER,
  claimer_name TEXT,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  reward TEXT,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','claimed','done')),
  created_at TEXT NOT NULL DEFAULT (date('now'))
);

CREATE TABLE IF NOT EXISTS grades (
  student_id INTEGER PRIMARY KEY,
  image TEXT, quiz TEXT, project TEXT, comment TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(student_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS capability_layout (
  id INTEGER PRIMARY KEY CHECK(id=1),
  layout TEXT
);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '新会话',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chats_user_updated ON chats(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id, id);
`);

// ===== Lightweight migrations for older DBs =====
function colExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === col);
}
if (!colExists('users', 'blocked')) {
  db.exec(`ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0`);
}

// Migrate singleton settings → api_configs (one-shot, only if api_configs is empty)
{
  const cnt = db.prepare(`SELECT COUNT(*) c FROM api_configs`).get().c;
  if (cnt === 0) {
    const s = db.prepare(`SELECT key, value FROM settings`).all();
    const m = Object.fromEntries(s.map((r) => [r.key, r.value]));
    if (m.llm_url && m.llm_key && m.llm_model) {
      db.prepare(`INSERT INTO api_configs (kind, name, url, api_key, model, active) VALUES ('llm', '导入的旧配置', ?, ?, ?, 1)`)
        .run(m.llm_url, m.llm_key, m.llm_model);
    }
    if (m.image_url && m.image_key && m.image_model) {
      db.prepare(`INSERT INTO api_configs (kind, name, url, api_key, model, active) VALUES ('image', '导入的旧配置', ?, ?, ?, 1)`)
        .run(m.image_url, m.image_key, m.image_model);
    }
  }
}

// ===== Seed =====
const insertUser = db.prepare(`INSERT OR IGNORE INTO users (username, password_hash, role) VALUES (?, ?, ?)`);
function seedUser(u) {
  insertUser.run(u.username, bcrypt.hashSync(u.password, 10), u.role);
}
seedUser(SEED_ADMIN);
for (const u of SEED_USERS) seedUser(u);

// Default settings keys
const insSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
['llm_url','llm_key','llm_model','image_url','image_key','image_model'].forEach((k) => insSetting.run(k, ''));

// Seed initial tickets if table empty
const ticketCount = db.prepare(`SELECT COUNT(*) c FROM tickets`).get().c;
if (ticketCount === 0) {
  const insT = db.prepare(`INSERT INTO tickets (publisher_name, title, company, reward, description, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`);
  insT.run('qiye', '便携蓝牙音箱 Amazon 上架素材包', '深圳某 3C 卖家', '￥300',
    '需要 1 套白底主图 + 5 张场景图 + 5 点描述（英文）+ 关键词清单。', '2026-04-28');
  insT.run('qiye', '夏季新品 TikTok 30s 短视频脚本 ×3', '广州女装独立站', '￥200',
    '产品为亚麻连衣裙，目标市场美国/欧洲，要求脚本含分镜与配乐建议。', '2026-04-30');
  insT.run('qiye', '智能晾衣杆竞品分析报告', '宁波家居出口商', '￥350',
    '锁定 Amazon US 站 Top 5 同类产品，输出价格、卖点、差评关键词、切入机会。', '2026-05-01');
}

// ===== App =====
const app = Fastify({
  logger: { level: 'info', transport: undefined },
  bodyLimit: 16 * 1024 * 1024,
});
await app.register(sensible);
await app.register(cookie);

// ===== Auth helpers =====
function signToken(user) {
  return jwt.sign({ uid: user.id, u: user.username, r: user.role }, JWT_SECRET, { expiresIn: SESSION_DAYS + 'd' });
}
function setAuthCookie(reply, token) {
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE,
    path: '/', maxAge: SESSION_DAYS * 86400,
  });
}
function clearAuthCookie(reply) {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}
function readUser(req) {
  const t = req.cookies?.[COOKIE_NAME];
  if (!t) return null;
  try {
    const p = jwt.verify(t, JWT_SECRET);
    // Check user still exists, role unchanged, not blocked
    const row = db.prepare(`SELECT id, username, role, blocked FROM users WHERE id = ?`).get(p.uid);
    if (!row || row.blocked) return null;
    return { id: row.id, username: row.username, role: row.role };
  } catch { return null; }
}
function requireUser(req, reply, role) {
  const u = readUser(req);
  if (!u) { reply.code(401).send({ error: 'unauthenticated' }); return null; }
  if (role) {
    const roles = Array.isArray(role) ? role : [role];
    if (!roles.includes(u.role)) { reply.code(403).send({ error: 'forbidden' }); return null; }
  }
  return u;
}

// ===== Validation =====
const RE_USER = /^[A-Za-z0-9_\u4e00-\u9fa5]{3,30}$/;
function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 8 || p.length > 100) return '密码长度需为 8-100 位';
  if (!/[A-Za-z]/.test(p)) return '密码需包含字母';
  if (!/[0-9]/.test(p)) return '密码需包含数字';
  return null;
}
function validateUsername(name) {
  if (typeof name !== 'string') return '用户名无效';
  if (!RE_USER.test(name)) return '用户名 3-30 位，只能包含字母、数字、下划线、中文';
  return null;
}

// ===== Auth routes =====
app.post('/api/auth/register', async (req, reply) => {
  const { username, password, role } = req.body || {};
  if (!['student','teacher','enterprise'].includes(role)) return reply.code(400).send({ error: '角色无效' });
  const ue = validateUsername(username); if (ue) return reply.code(400).send({ error: ue });
  if (username === SEED_ADMIN.username) return reply.code(400).send({ error: '用户名已被保留' });
  const pe = validatePassword(password); if (pe) return reply.code(400).send({ error: pe });
  const exists = db.prepare(`SELECT id FROM users WHERE username = ?`).get(username);
  if (exists) return reply.code(409).send({ error: '用户名已存在' });
  const hash = bcrypt.hashSync(password, 10);
  const r = db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`).run(username, hash, role);
  setAuthCookie(reply, signToken({ id: r.lastInsertRowid, username, role }));
  return { ok: true, user: { username, role } };
});

app.post('/api/auth/login', async (req, reply) => {
  const { username, password, asAdmin } = req.body || {};
  if (!username || !password) return reply.code(400).send({ error: '请输入用户名和密码' });
  const row = db.prepare(`SELECT id, username, password_hash, role, blocked FROM users WHERE username = ?`).get(username);
  if (!row) return reply.code(401).send({ error: '用户名不存在' });
  if (row.blocked) return reply.code(403).send({ error: '该账号已被管理员封禁' });
  if (asAdmin && row.role !== 'admin') return reply.code(403).send({ error: '该账号不是管理员' });
  if (!asAdmin && row.role === 'admin') return reply.code(403).send({ error: '请勾选「管理员」身份登录' });
  if (!bcrypt.compareSync(password, row.password_hash)) return reply.code(401).send({ error: '密码错误' });
  setAuthCookie(reply, signToken(row));
  return { ok: true, user: { username: row.username, role: row.role } };
});

app.post('/api/auth/logout', async (req, reply) => {
  clearAuthCookie(reply);
  return { ok: true };
});

app.get('/api/auth/me', async (req, reply) => {
  const u = readUser(req);
  if (!u) return reply.code(401).send({ error: 'unauthenticated' });
  return { user: { username: u.username, role: u.role } };
});

// ===== Settings (admin only) =====
function getApiConfig() {
  const llm = db.prepare(`SELECT url, api_key as key, model FROM api_configs WHERE kind='llm' AND active=1 LIMIT 1`).get();
  const image = db.prepare(`SELECT url, api_key as key, model FROM api_configs WHERE kind='image' AND active=1 LIMIT 1`).get();
  return {
    llm:   llm   || { url: '', key: '', model: '' },
    image: image || { url: '', key: '', model: '' },
  };
}
// ===== Compliance knowledge base (loaded on boot) =====
const COMPLIANCE_DIR = path.join(path.dirname(DB_PATH), 'compliance');
const compliance = {
  loaded: false,
  docs: [],     // [{ filename, source, text, lower }]
  totalChars: 0,
};
function loadCompliance() {
  compliance.loaded = false;
  compliance.docs = [];
  compliance.totalChars = 0;
  if (!existsSync(COMPLIANCE_DIR)) {
    app.log.warn(`compliance dir not found: ${COMPLIANCE_DIR}`);
    return;
  }
  let manifest = null;
  const mfPath = path.join(COMPLIANCE_DIR, 'manifest.json');
  if (existsSync(mfPath)) {
    try { manifest = JSON.parse(readFileSync(mfPath, 'utf8')); } catch {}
  }
  const byFile = {};
  if (manifest?.files) for (const f of manifest.files) byFile[f.textFile] = f;

  const files = readdirSync(COMPLIANCE_DIR).filter((f) => f.endsWith('.txt')).sort();
  for (const f of files) {
    try {
      const text = readFileSync(path.join(COMPLIANCE_DIR, f), 'utf8');
      const meta = byFile[f] || {};
      const sourceName = meta.sourceRel || f.replace(/\.txt$/, '');
      compliance.docs.push({
        filename: f,
        source: sourceName,
        text,
        lower: (sourceName + '\n' + text).toLowerCase(),
        chars: text.length,
      });
      compliance.totalChars += text.length;
    } catch (e) {
      app.log.warn(`failed to load compliance ${f}: ${e.message}`);
    }
  }
  compliance.loaded = true;
  app.log.info(`compliance loaded: ${compliance.docs.length} docs, ${compliance.totalChars} chars`);
}

// Pick the most relevant docs for a user query (simple keyword scoring)
function searchCompliance(query, opts = {}) {
  if (!compliance.loaded || !compliance.docs.length) return [];
  const topK = opts.topK || 4;
  const q = (query || '').toLowerCase();
  // Build keyword list: split on common punctuation/whitespace + Chinese punct, drop length <2
  const tokens = q
    .replace(/[，。！？、；：""''（）\[\]【】《》,.!?;:()\[\]<>"'`~|\\/]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && t.length >= 2);
  if (!tokens.length) return [];
  // Also pull substring n-grams for Chinese (length 2-4) so cross-language tokenization works
  const grams = new Set();
  for (const t of tokens) {
    grams.add(t);
    for (let len = 2; len <= 4; len++) {
      for (let i = 0; i + len <= t.length; i++) grams.add(t.slice(i, i + len));
    }
  }
  const scored = compliance.docs.map((d) => {
    let score = 0;
    for (const g of grams) {
      let pos = 0;
      while ((pos = d.lower.indexOf(g, pos)) !== -1) { score++; pos += g.length; }
    }
    // Boost if query terms appear in source name
    for (const t of tokens) {
      if (d.source.toLowerCase().includes(t)) score += 5;
    }
    return { doc: d, score };
  }).filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  return scored.map((x) => x.doc);
}

// Build the compliance context block, capped in chars so we don't blow context window
function buildComplianceContext(query, charBudget = 18000) {
  const hits = searchCompliance(query);
  if (!hits.length) return '';
  let used = 0;
  const parts = [];
  for (const d of hits) {
    if (used >= charBudget) break;
    const remaining = charBudget - used;
    const slice = d.text.length <= remaining ? d.text : (d.text.slice(0, remaining) + `\n…（截断，原文档共 ${d.text.length} 字）`);
    parts.push(`【来源：${d.source}】\n${slice}`);
    used += slice.length;
  }
  return parts.join('\n\n---\n\n');
}

// Some image providers (e.g. 豆包 seedream) reject OpenAI's pixel sizes ("1024x1024").
// Map between formats based on provider hints in URL/model.
function mapImageSize(url, model, size) {
  const u = (url || '').toLowerCase();
  const m = (model || '').toLowerCase();
  const isDoubao = u.includes('volces.com') || m.includes('doubao') || m.includes('seedream');
  if (!isDoubao) return size; // OpenAI / others: pass through
  // Doubao expects '1K' | '2K' | '4K' (or ratio strings like '1:1')
  const s = String(size || '').trim();
  if (/^[124]K$/i.test(s)) return s.toUpperCase();
  if (/^\d+x\d+$/i.test(s)) {
    const [w] = s.toLowerCase().split('x').map(Number);
    if (w <= 768)  return '1K';
    if (w <= 1536) return '2K';
    return '4K';
  }
  return '2K'; // safe default
}

function getApiConfigSafe() {
  // For status check (returns booleans only)
  const cfg = getApiConfig();
  return {
    llm:   { configured: !!(cfg.llm.url   && cfg.llm.key   && cfg.llm.model) },
    image: { configured: !!(cfg.image.url && cfg.image.key && cfg.image.model) },
  };
}

// ----- Multi-config: list / create / edit / activate / delete / test -----
app.get('/api/admin/api-configs', async (req, reply) => {
  const u = requireUser(req, reply, 'admin'); if (!u) return;
  const rows = db.prepare(`SELECT id, kind, name, url, api_key as key, model, active, created_at FROM api_configs ORDER BY kind, active DESC, id`).all();
  return { configs: rows };
});

app.post('/api/admin/api-configs', async (req, reply) => {
  const u = requireUser(req, reply, 'admin'); if (!u) return;
  const { kind, name, url, key, model } = req.body || {};
  if (!['llm','image'].includes(kind)) return reply.code(400).send({ error: 'kind 应为 llm 或 image' });
  if (!name || !url || !key || !model) return reply.code(400).send({ error: '名称、URL、Key、模型 都必填' });
  const r = db.prepare(`INSERT INTO api_configs (kind, name, url, api_key, model, active) VALUES (?, ?, ?, ?, ?, 0)`)
    .run(kind, name.trim(), url.trim(), key.trim(), model.trim());
  // Auto-activate if no other active config of same kind
  const hasActive = db.prepare(`SELECT id FROM api_configs WHERE kind = ? AND active = 1`).get(kind);
  if (!hasActive) db.prepare(`UPDATE api_configs SET active = 1 WHERE id = ?`).run(r.lastInsertRowid);
  return { ok: true, id: r.lastInsertRowid };
});

app.put('/api/admin/api-configs/:id', async (req, reply) => {
  const u = requireUser(req, reply, 'admin'); if (!u) return;
  const id = +req.params.id;
  const cur = db.prepare(`SELECT * FROM api_configs WHERE id = ?`).get(id);
  if (!cur) return reply.code(404).send({ error: '配置不存在' });
  const { name, url, key, model } = req.body || {};
  db.prepare(`UPDATE api_configs SET name=?, url=?, api_key=?, model=? WHERE id=?`)
    .run(name ?? cur.name, url ?? cur.url, key ?? cur.api_key, model ?? cur.model, id);
  return { ok: true };
});

app.put('/api/admin/api-configs/:id/activate', async (req, reply) => {
  const u = requireUser(req, reply, 'admin'); if (!u) return;
  const id = +req.params.id;
  const cur = db.prepare(`SELECT kind FROM api_configs WHERE id = ?`).get(id);
  if (!cur) return reply.code(404).send({ error: '配置不存在' });
  // Atomic: deactivate all of this kind, then activate this one
  const tx = db.transaction(() => {
    db.prepare(`UPDATE api_configs SET active = 0 WHERE kind = ?`).run(cur.kind);
    db.prepare(`UPDATE api_configs SET active = 1 WHERE id = ?`).run(id);
  });
  tx();
  return { ok: true };
});

app.delete('/api/admin/api-configs/:id', async (req, reply) => {
  const u = requireUser(req, reply, 'admin'); if (!u) return;
  const id = +req.params.id;
  const r = db.prepare(`DELETE FROM api_configs WHERE id = ?`).run(id);
  if (!r.changes) return reply.code(404).send({ error: '配置不存在' });
  return { ok: true };
});

// Test a specific stored config (uses its own URL/Key/model, not the active one)
app.post('/api/admin/api-configs/:id/test', async (req, reply) => {
  const u = requireUser(req, reply, 'admin'); if (!u) return;
  const id = +req.params.id;
  const cfg = db.prepare(`SELECT kind, url, api_key as key, model FROM api_configs WHERE id = ?`).get(id);
  if (!cfg) return reply.code(404).send({ error: '配置不存在' });
  try {
    if (cfg.kind === 'llm') {
      const resp = await fetch(cfg.url.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
        body: JSON.stringify({ model: cfg.model, messages: [{role:'user', content:'你好，请回复 "ok"'}], max_tokens: 16 }),
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        return { ok: false, message: `失败 (${resp.status})：${t.slice(0, 200) || resp.statusText}` };
      }
      const d = await resp.json();
      const c = d?.choices?.[0]?.message?.content;
      if (!c) return { ok: false, message: '响应为空（可能不是 OpenAI 兼容格式）' };
      return { ok: true, message: `成功！模型回复：${String(c).slice(0, 80)}` };
    } else {
      const resp = await fetch(cfg.url.replace(/\/+$/, '') + '/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
        body: JSON.stringify({ model: cfg.model, prompt: 'a small red apple, plain background, test', n: 1, size: mapImageSize(cfg.url, cfg.model, '512x512') }),
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        return { ok: false, message: `失败 (${resp.status})：${t.slice(0, 200) || resp.statusText}` };
      }
      const d = await resp.json();
      const item = d?.data?.[0];
      if (!item || (!item.url && !item.b64_json)) return { ok: false, message: '响应未包含图像数据' };
      return { ok: true, message: '成功！已收到 1 张图像' };
    }
  } catch (e) { return { ok: false, message: '网络错误：' + e.message }; }
});

// API status (any logged-in user can see if it's configured, but never the keys)
app.get('/api/api-status', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  return getApiConfigSafe();
});

// ===== Admin: users =====
app.get('/api/admin/users', async (req, reply) => {
  const u = requireUser(req, reply, 'admin'); if (!u) return;
  const rows = db.prepare(`SELECT id, username, role, blocked, created_at FROM users WHERE role != 'admin' ORDER BY created_at DESC`).all();
  return { users: rows };
});
app.delete('/api/admin/users/:username', async (req, reply) => {
  const u = requireUser(req, reply, 'admin'); if (!u) return;
  if (req.params.username === SEED_ADMIN.username) return reply.code(400).send({ error: '不能删除管理员账号' });
  db.prepare(`DELETE FROM users WHERE username = ? AND role != 'admin'`).run(req.params.username);
  return { ok: true };
});

// Admin: create user
app.post('/api/admin/users', async (req, reply) => {
  const u = requireUser(req, reply, 'admin'); if (!u) return;
  const { username, password, role } = req.body || {};
  if (!['student','teacher','enterprise'].includes(role)) return reply.code(400).send({ error: '角色无效' });
  const ue = validateUsername(username); if (ue) return reply.code(400).send({ error: ue });
  if (username === SEED_ADMIN.username) return reply.code(400).send({ error: '该用户名已被保留' });
  const pe = validatePassword(password); if (pe) return reply.code(400).send({ error: pe });
  const exists = db.prepare(`SELECT id FROM users WHERE username = ?`).get(username);
  if (exists) return reply.code(409).send({ error: '用户名已存在' });
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`).run(username, hash, role);
  return { ok: true };
});

// Admin: reset password
app.put('/api/admin/users/:username/password', async (req, reply) => {
  const u = requireUser(req, reply, 'admin'); if (!u) return;
  const { password } = req.body || {};
  const pe = validatePassword(password); if (pe) return reply.code(400).send({ error: pe });
  if (req.params.username === SEED_ADMIN.username) return reply.code(400).send({ error: '请通过其他方式修改管理员密码' });
  const r = db.prepare(`UPDATE users SET password_hash = ? WHERE username = ? AND role != 'admin'`).run(bcrypt.hashSync(password, 10), req.params.username);
  if (!r.changes) return reply.code(404).send({ error: '用户不存在' });
  return { ok: true };
});

// Admin: block / unblock
app.put('/api/admin/users/:username/block', async (req, reply) => {
  const u = requireUser(req, reply, 'admin'); if (!u) return;
  const { blocked } = req.body || {};
  if (req.params.username === SEED_ADMIN.username) return reply.code(400).send({ error: '不能封禁管理员账号' });
  const r = db.prepare(`UPDATE users SET blocked = ? WHERE username = ? AND role != 'admin'`).run(blocked ? 1 : 0, req.params.username);
  if (!r.changes) return reply.code(404).send({ error: '用户不存在' });
  return { ok: true };
});

// Admin: per-user usage stats
app.get('/api/admin/usage', async (req, reply) => {
  const u = requireUser(req, reply, 'admin'); if (!u) return;
  const rows = db.prepare(`
    SELECT
      u.id, u.username, u.role,
      COUNT(CASE WHEN l.kind='chat' THEN 1 END) AS chat_count,
      COALESCE(SUM(CASE WHEN l.kind='chat' THEN l.tokens END), 0) AS chat_tokens,
      COUNT(CASE WHEN l.kind='image' THEN 1 END) AS image_count,
      MAX(l.created_at) AS last_used
    FROM users u
    LEFT JOIN usage_log l ON l.user_id = u.id
    WHERE u.role != 'admin'
    GROUP BY u.id
    ORDER BY chat_count + image_count DESC, u.username
  `).all();
  // Also today's totals
  const today = db.prepare(`
    SELECT
      COUNT(CASE WHEN kind='chat' THEN 1 END) AS chat_today,
      COALESCE(SUM(CASE WHEN kind='chat' THEN tokens END), 0) AS tokens_today,
      COUNT(CASE WHEN kind='image' THEN 1 END) AS image_today
    FROM usage_log WHERE date(created_at) = date('now')
  `).get();
  return { rows, today };
});

// Admin: edit / delete any ticket
app.put('/api/admin/tickets/:id', async (req, reply) => {
  const u = requireUser(req, reply, 'admin'); if (!u) return;
  const id = +req.params.id;
  const { title, company, reward, description, status } = req.body || {};
  const cur = db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(id);
  if (!cur) return reply.code(404).send({ error: '工单不存在' });
  const next = {
    title: title ?? cur.title,
    company: company ?? cur.company,
    reward: reward ?? cur.reward,
    description: description ?? cur.description,
    status: ['open','claimed','done'].includes(status) ? status : cur.status,
  };
  db.prepare(`UPDATE tickets SET title=?, company=?, reward=?, description=?, status=? WHERE id=?`)
    .run(next.title, next.company, next.reward, next.description, next.status, id);
  return { ok: true };
});
app.delete('/api/admin/tickets/:id', async (req, reply) => {
  const u = requireUser(req, reply, 'admin'); if (!u) return;
  const r = db.prepare(`DELETE FROM tickets WHERE id = ?`).run(+req.params.id);
  if (!r.changes) return reply.code(404).send({ error: '工单不存在' });
  return { ok: true };
});

// Admin: download SQLite DB backup
app.get('/api/admin/export/db', async (req, reply) => {
  const u = requireUser(req, reply, 'admin'); if (!u) return;
  // Force WAL checkpoint so the backup file is consistent
  db.pragma('wal_checkpoint(FULL)');
  const stat = statSync(DB_PATH);
  reply
    .header('Content-Type', 'application/octet-stream')
    .header('Content-Length', stat.size)
    .header('Content-Disposition', `attachment; filename="baize-${new Date().toISOString().slice(0,10)}.db"`);
  return reply.send(createReadStream(DB_PATH));
});

// Admin: CSV export of a single table
app.get('/api/admin/export/csv/:table', async (req, reply) => {
  const u = requireUser(req, reply, 'admin'); if (!u) return;
  const ALLOWED = ['users','tickets','knowledge','schedule','grades','usage_log','settings'];
  const table = req.params.table;
  if (!ALLOWED.includes(table)) return reply.code(400).send({ error: '不支持的表' });
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  if (!rows.length) {
    reply.header('Content-Type', 'text/csv; charset=utf-8')
         .header('Content-Disposition', `attachment; filename="${table}.csv"`);
    return reply.send('(empty)\n');
  }
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/["\n,]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  // Hide password hashes for safety
  const hidden = new Set(['password_hash']);
  const visibleCols = cols.filter((c) => !hidden.has(c));
  const csv = '\uFEFF' + visibleCols.join(',') + '\n' +
    rows.map((r) => visibleCols.map((c) => esc(r[c])).join(',')).join('\n') + '\n';
  reply.header('Content-Type', 'text/csv; charset=utf-8')
       .header('Content-Disposition', `attachment; filename="${table}.csv"`);
  return reply.send(csv);
});

// Admin: read recent logs
app.get('/api/admin/logs', async (req, reply) => {
  const u = requireUser(req, reply, 'admin'); if (!u) return;
  const lines = Math.min(+(req.query?.lines) || 200, 2000);
  try {
    const { stdout } = await execP(`journalctl -u baize-api -n ${lines} --no-pager --output=short-iso`, { maxBuffer: 8 * 1024 * 1024 });
    return { logs: stdout };
  } catch (e) {
    return { logs: '(无法读取日志：' + e.message + ')' };
  }
});

// ===== Chat (LLM proxy) =====
app.post('/api/chat', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const { agentName, agentRole, agentIntro, messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return reply.code(400).send({ error: 'messages 必填' });
  const cfg = getApiConfig();
  if (!cfg.llm.url || !cfg.llm.key || !cfg.llm.model) {
    return reply.code(503).send({ error: '系统暂未配置大语言模型 API。请联系管理员。' });
  }
  // Per-agent extras: 合规分析 走本地知识库（静默融合，不暴露元信息）
  let ragBlock = '';
  if (agentName === '产品合规分析') {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    let queryText = '';
    if (lastUser) {
      if (typeof lastUser.content === 'string') queryText = lastUser.content;
      else if (Array.isArray(lastUser.content)) {
        queryText = lastUser.content.filter((p) => p.type === 'text').map((p) => p.text || '').join(' ');
      }
    }
    if (queryText) {
      const ctx = buildComplianceContext(queryText, 18000);
      if (ctx) {
        ragBlock = [
          '',
          '【内部参考资料 · 仅供你内部使用，不要在回答中提及】',
          ctx,
          '【参考资料结束】',
          '',
        ].join('\n');
      }
    }
  }

  const sys = [
    `你叫「泽宝」，是「白泽 · 跨境电商智能体平台」的官方智能助手。`,
    `当前你正承担「${agentName || 'AI 助手'}」这个专业角色（面向：${agentRole || '通用'}），按该角色的工作流为用户服务。`,
    '',
    String(agentIntro || '').replace(/<[^>]*>/g, ''),
    '',
    '身份与口吻：',
    '- 用户问"你是谁/你叫什么名字/你是哪家AI/底层模型"等身份相关问题时，统一回答："我是泽宝，是白泽平台的智能助手"；不要透露你的底层大模型、厂商、版本号；',
    '- 自称"泽宝"或"我"，不要自称"AI助手""我是一个语言模型"等；',
    '- 风格亲切、专业、克制，不阿谀。',
    '',
    '回答规则：',
    '- 用中文回答（除非用户主动用其他语言）；',
    '- 输出结构化、可执行、贴合工作流的内容（合适的标题、列表、表格）；',
    '- 给出具体方案、示例和数字，不要泛泛而谈；',
    '- 信息不足以完成任务时，先简要列出所需关键信息再继续。',
    `\n图文混排能力（强烈建议使用）：
- 当一张图能让回答更直观（产品场景示例、营销视觉参考、风格情绪板、构图示意、分析图等）时，请在合适位置另起一行写：
  [IMG: <一段详细的英文图像生成 prompt，描述主体/风格/构图/光线/材质等>]
- 系统会自动把这个标记替换成生成好的图片插入到对话里。
- 单次回答最多用 3 张图，仅在真正能加分时使用，避免堆砌；提示词必须是英文、具体、有视觉细节。`,
    ragBlock ? '\n关于内部参考资料的使用规则：\n- 上方【内部参考资料】是平台合规文档原文，仅供你参考，绝对不要在回答中提及"参考资料""文档名""资料库""数据来源""根据xxx文档"等任何元信息；\n- 自然地把资料里的事实融进回答，让用户感觉是你自己专业知识的一部分；\n- 资料里没有覆盖的部分，自然地补充你的专业判断；不要说"以下为常识""未找到"等任何元说明，直接给答案；\n- 整体保持权威、流畅、连贯，像资深人类专家在写报告。' : '',
    ragBlock,
  ].join('\n');
  const finalMessages = [{ role: 'system', content: sys }, ...messages];
  try {
    const resp = await fetch(cfg.llm.url.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.llm.key}` },
      body: JSON.stringify({ model: cfg.llm.model, messages: finalMessages, stream: false }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return reply.code(502).send({ error: `上游 ${resp.status}：${t.slice(0, 300)}` });
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return reply.code(502).send({ error: '上游返回为空' });
    const tokens = data?.usage?.total_tokens || 0;
    db.prepare(`INSERT INTO usage_log (user_id, kind, tokens) VALUES (?, 'chat', ?)`).run(u.id, tokens);

    // Process inline image markers — generate images for each [IMG: ...] tag in parallel
    const rawText = typeof content === 'string' ? content : JSON.stringify(content);
    const finalText = await processInlineImages(rawText, u.id);
    return { reply: finalText };
  } catch (e) {
    return reply.code(502).send({ error: '上游网络错误：' + e.message });
  }
});

// ===== Inline image generator (replaces [IMG: prompt] markers in chat replies) =====
async function processInlineImages(text, userId) {
  const MARKER_RE = /\[IMG:\s*([^\]\n]{4,500})\]/g;
  const matches = [...text.matchAll(MARKER_RE)];
  if (!matches.length) return text;
  const cfg = getApiConfig().image;
  if (!cfg.url || !cfg.key || !cfg.model) {
    // No image API configured — fail soft: keep markers as italic note
    return text.replace(MARKER_RE, (_, p) => `\n_[此处建议附图：${p.trim()}（系统未配置 AI 画图 API）]_\n`);
  }
  const MAX_IMAGES = 3;
  const limited = matches.slice(0, MAX_IMAGES);
  const ep = cfg.url.replace(/\/+$/, '') + '/images/generations';

  const inlineSize = mapImageSize(cfg.url, cfg.model, '1024x1024');
  async function genOne(prompt) {
    try {
      const resp = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
        body: JSON.stringify({ model: cfg.model, prompt, n: 1, size: inlineSize }),
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        return { ok: false, msg: `生成失败 (${resp.status})：${t.slice(0, 80)}` };
      }
      const d = await resp.json();
      const item = d?.data?.[0];
      const url = item?.url || (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : null);
      if (!url) return { ok: false, msg: '上游未返回图像数据' };
      return { ok: true, url };
    } catch (e) {
      return { ok: false, msg: '网络错误：' + e.message };
    }
  }

  const results = await Promise.all(limited.map((m) => genOne(m[1].trim())));
  // Log successful image generations to usage
  const successCount = results.filter((r) => r.ok).length;
  if (successCount > 0) {
    db.prepare(`INSERT INTO usage_log (user_id, kind, tokens) VALUES (?, 'image', ?)`).run(userId, successCount);
  }

  let out = text;
  for (let i = 0; i < limited.length; i++) {
    const m = limited[i];
    const r = results[i];
    const replacement = r.ok
      ? `\n\n![${m[1].trim().replace(/\]/g, '')}](${r.url})\n\n`
      : `\n_[图像生成失败：${r.msg}]_\n`;
    out = out.replace(m[0], replacement);
  }
  // Drop any markers beyond the limit (rare)
  out = out.replace(MARKER_RE, '');
  return out;
}

// ===== Image generation =====
app.post('/api/image', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const { prompt, n = 1, size = '1024x1024' } = req.body || {};
  if (!prompt) return reply.code(400).send({ error: 'prompt 必填' });
  const cfg = getApiConfig();
  if (!cfg.image.url || !cfg.image.key || !cfg.image.model) {
    return reply.code(503).send({ error: '系统暂未配置图像生成 API。请联系管理员。' });
  }
  try {
    const resp = await fetch(cfg.image.url.replace(/\/+$/, '') + '/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.image.key}` },
      body: JSON.stringify({ model: cfg.image.model, prompt, n: Math.min(+n || 1, 8), size: mapImageSize(cfg.image.url, cfg.image.model, size) }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return reply.code(502).send({ error: `上游 ${resp.status}：${t.slice(0, 300)}` });
    }
    const data = await resp.json();
    const items = (data?.data || []).map((it) => ({
      url: it.url || (it.b64_json ? `data:image/png;base64,${it.b64_json}` : null),
    })).filter((x) => x.url);
    if (!items.length) return reply.code(502).send({ error: '上游未返回图像数据' });
    db.prepare(`INSERT INTO usage_log (user_id, kind, tokens) VALUES (?, 'image', ?)`).run(u.id, items.length);
    return { images: items };
  } catch (e) {
    return reply.code(502).send({ error: '上游网络错误：' + e.message });
  }
});

// ===== API connectivity test (admin) =====
app.post('/api/admin/api-test', async (req, reply) => {
  const u = requireUser(req, reply, 'admin'); if (!u) return;
  const { which } = req.body || {};
  const cfg = getApiConfig();
  if (which === 'llm') {
    if (!cfg.llm.url || !cfg.llm.key || !cfg.llm.model) return reply.code(400).send({ error: '请先填写并保存 LLM 配置' });
    try {
      const resp = await fetch(cfg.llm.url.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.llm.key}` },
        body: JSON.stringify({ model: cfg.llm.model, messages: [{role:'user', content:'你好，请回复 "ok"'}], max_tokens: 16 }),
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        return { ok: false, message: `失败 (${resp.status})：${t.slice(0, 200) || resp.statusText}` };
      }
      const d = await resp.json();
      const c = d?.choices?.[0]?.message?.content;
      if (!c) return { ok: false, message: '响应为空（可能不是 OpenAI 兼容格式）' };
      return { ok: true, message: `成功！模型回复：${String(c).slice(0, 80)}` };
    } catch (e) { return { ok: false, message: '网络错误：' + e.message }; }
  }
  if (which === 'image') {
    if (!cfg.image.url || !cfg.image.key || !cfg.image.model) return reply.code(400).send({ error: '请先填写并保存图像配置' });
    try {
      const resp = await fetch(cfg.image.url.replace(/\/+$/, '') + '/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.image.key}` },
        body: JSON.stringify({ model: cfg.image.model, prompt: 'a small red apple, plain background, test', n: 1, size: mapImageSize(cfg.image.url, cfg.image.model, '512x512') }),
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        return { ok: false, message: `失败 (${resp.status})：${t.slice(0, 200) || resp.statusText}` };
      }
      const d = await resp.json();
      const item = d?.data?.[0];
      if (!item || (!item.url && !item.b64_json)) return { ok: false, message: '响应未包含图像数据' };
      return { ok: true, message: '成功！已收到 1 张图像（' + (item.url ? 'URL 模式' : 'base64 模式') + '）' };
    } catch (e) { return { ok: false, message: '网络错误：' + e.message }; }
  }
  return reply.code(400).send({ error: 'which 应为 llm 或 image' });
});

// ===== Schedule =====
app.get('/api/schedule', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const rows = db.prepare(`SELECT id, date, payload FROM schedule WHERE user_id = ?`).all(u.id);
  const out = {};
  for (const r of rows) {
    const t = JSON.parse(r.payload); t.id = r.id;
    (out[r.date] ||= []).push(t);
  }
  return { schedule: out };
});
app.post('/api/schedule', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const { date, task } = req.body || {};
  if (!date || !task || !task.text) return reply.code(400).send({ error: 'date 和 task.text 必填' });
  const r = db.prepare(`INSERT INTO schedule (user_id, date, payload) VALUES (?, ?, ?)`).run(u.id, date, JSON.stringify(task));
  return { ok: true, id: r.lastInsertRowid };
});
app.put('/api/schedule/:id', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const id = +req.params.id;
  const { task } = req.body || {};
  const row = db.prepare(`SELECT user_id FROM schedule WHERE id = ?`).get(id);
  if (!row || row.user_id !== u.id) return reply.code(404).send({ error: '任务不存在' });
  db.prepare(`UPDATE schedule SET payload = ? WHERE id = ?`).run(JSON.stringify(task), id);
  return { ok: true };
});
app.delete('/api/schedule/:id', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const id = +req.params.id;
  const row = db.prepare(`SELECT user_id FROM schedule WHERE id = ?`).get(id);
  if (!row || row.user_id !== u.id) return reply.code(404).send({ error: '任务不存在' });
  db.prepare(`DELETE FROM schedule WHERE id = ?`).run(id);
  return { ok: true };
});

// ===== Knowledge base =====
app.get('/api/knowledge', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const rows = db.prepare(`SELECT id, title, tag, content, created_at FROM knowledge WHERE user_id = ? ORDER BY id DESC`).all(u.id);
  return { entries: rows };
});
app.post('/api/knowledge', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const { title, tag, content } = req.body || {};
  if (!title || !content) return reply.code(400).send({ error: '标题和内容必填' });
  const r = db.prepare(`INSERT INTO knowledge (user_id, title, tag, content) VALUES (?, ?, ?, ?)`).run(u.id, title, tag || '', content);
  return { ok: true, id: r.lastInsertRowid };
});
app.delete('/api/knowledge/:id', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const id = +req.params.id;
  const row = db.prepare(`SELECT user_id FROM knowledge WHERE id = ?`).get(id);
  if (!row || row.user_id !== u.id) return reply.code(404).send({ error: '不存在' });
  db.prepare(`DELETE FROM knowledge WHERE id = ?`).run(id);
  return { ok: true };
});

// ===== Tickets =====
app.get('/api/tickets', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const rows = db.prepare(`SELECT * FROM tickets ORDER BY id DESC`).all();
  return { tickets: rows };
});
app.post('/api/tickets', async (req, reply) => {
  const u = requireUser(req, reply, 'enterprise'); if (!u) return;
  const { title, company, reward, description } = req.body || {};
  if (!title || !description) return reply.code(400).send({ error: '标题和描述必填' });
  const r = db.prepare(`INSERT INTO tickets (publisher_id, publisher_name, title, company, reward, description) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(u.id, u.username, title, company || u.username, reward || '面议', description);
  return { ok: true, id: r.lastInsertRowid };
});
app.post('/api/tickets/:id/claim', async (req, reply) => {
  const u = requireUser(req, reply, 'student'); if (!u) return;
  const id = +req.params.id;
  const row = db.prepare(`SELECT status FROM tickets WHERE id = ?`).get(id);
  if (!row) return reply.code(404).send({ error: '工单不存在' });
  if (row.status !== 'open') return reply.code(400).send({ error: '该工单已被认领或完成' });
  db.prepare(`UPDATE tickets SET status='claimed', claimer_id=?, claimer_name=? WHERE id = ?`).run(u.id, u.username, id);
  return { ok: true };
});
app.post('/api/tickets/:id/finish', async (req, reply) => {
  const u = requireUser(req, reply, 'student'); if (!u) return;
  const id = +req.params.id;
  const row = db.prepare(`SELECT claimer_id, status FROM tickets WHERE id = ?`).get(id);
  if (!row) return reply.code(404).send({ error: '工单不存在' });
  if (row.claimer_id !== u.id) return reply.code(403).send({ error: '只能完成自己认领的工单' });
  if (row.status !== 'claimed') return reply.code(400).send({ error: '状态不允许' });
  db.prepare(`UPDATE tickets SET status='done' WHERE id = ?`).run(id);
  return { ok: true };
});

// ===== Grades =====
app.get('/api/grades', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  if (u.role === 'student') {
    const row = db.prepare(`SELECT * FROM grades WHERE student_id = ?`).get(u.id);
    return { rows: [{ student_id: u.id, username: u.username, ...(row || {}) }] };
  }
  if (u.role === 'teacher' || u.role === 'admin') {
    const students = db.prepare(`SELECT id, username FROM users WHERE role = 'student' ORDER BY username`).all();
    const grades = db.prepare(`SELECT * FROM grades`).all();
    const byStu = Object.fromEntries(grades.map((g) => [g.student_id, g]));
    const merged = students.map((s) => ({ student_id: s.id, username: s.username, ...(byStu[s.id] || {}) }));
    return { rows: merged };
  }
  return { rows: [] };
});
app.put('/api/grades/:username', async (req, reply) => {
  const u = requireUser(req, reply, ['teacher','admin']); if (!u) return;
  const stu = db.prepare(`SELECT id FROM users WHERE username = ? AND role = 'student'`).get(req.params.username);
  if (!stu) return reply.code(404).send({ error: '学生不存在' });
  const { image, quiz, project, comment } = req.body || {};
  db.prepare(`
    INSERT INTO grades (student_id, image, quiz, project, comment, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(student_id) DO UPDATE SET
      image=excluded.image, quiz=excluded.quiz, project=excluded.project,
      comment=excluded.comment, updated_at=excluded.updated_at
  `).run(stu.id, image || '', quiz || '', project || '', comment || '');
  return { ok: true };
});

// ===== Capability layout =====
app.get('/api/capability/layout', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const row = db.prepare(`SELECT layout FROM capability_layout WHERE id = 1`).get();
  return { layout: row ? JSON.parse(row.layout) : null };
});
app.put('/api/capability/layout', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const { layout } = req.body || {};
  if (!layout) return reply.code(400).send({ error: 'layout 必填' });
  db.prepare(`
    INSERT INTO capability_layout (id, layout) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET layout = excluded.layout
  `).run(JSON.stringify(layout));
  return { ok: true };
});

// ===== Chats: 持久化多轮会话 =====
function buildExpertSystemPrompt() {
  return [
    `你叫「泽宝」，是「白泽 · 跨境电商智能体平台」的官方智能助手。`,
    `当前你扮演「跨境电商专家」的综合角色，能回答跨境电商各方面的问题：选品、合规、营销、物流、运营、店铺装修、广告投放、客服、数据分析、品牌、独立站、Amazon / Shopify / TikTok Shop 等。`,
    '',
    '身份与口吻：',
    '- 用户问"你是谁/你叫什么名字/你是哪家AI/底层模型"等身份相关问题时，统一回答："我是泽宝，是白泽平台的智能助手"；不要透露你的底层大模型、厂商、版本号；',
    '- 自称"泽宝"或"我"，不要自称"AI助手""我是一个语言模型"等；',
    '- 风格亲切、专业、克制，不阿谀。',
    '',
    '回答规则：',
    '- 用中文回答（除非用户主动用其他语言）；',
    '- 输出结构化、可执行、贴合工作流的内容（合适的标题、列表、表格）；',
    '- 给出具体方案、示例和数字，不要泛泛而谈；',
    '- 信息不足以完成任务时，先简要列出所需关键信息再继续。',
    '',
    `图文混排能力：
- 当一张图能让回答更直观（产品场景示例、营销视觉参考、风格情绪板、构图示意、分析图等）时，请在合适位置另起一行写：
  [IMG: <一段详细的英文图像生成 prompt，描述主体/风格/构图/光线/材质等>]
- 系统会自动把这个标记替换成生成好的图片插入到对话里。
- 单次回答最多用 3 张图，仅在真正能加分时使用，避免堆砌；提示词必须是英文、具体、有视觉细节。`
  ].join('\n');
}

function chatToLLMMessages(rows) {
  // rows: [{role, content (JSON string)}]
  return rows.map((h) => {
    let c; try { c = JSON.parse(h.content); } catch { c = { text: '' }; }
    if (h.role === 'user') {
      if (c.images && c.images.length) {
        const parts = [];
        if (c.text) parts.push({ type: 'text', text: c.text });
        for (const img of c.images) parts.push({ type: 'image_url', image_url: { url: img } });
        return { role: 'user', content: parts };
      }
      return { role: 'user', content: c.text || '' };
    }
    return { role: 'assistant', content: c.text || '' };
  });
}

app.post('/api/chats', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const r = db.prepare(`INSERT INTO chats (user_id) VALUES (?)`).run(u.id);
  return { id: r.lastInsertRowid, title: '新会话' };
});

app.get('/api/chats', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const rows = db.prepare(`SELECT id, title, updated_at FROM chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50`).all(u.id);
  return { chats: rows };
});

app.get('/api/chats/:id', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const id = +req.params.id;
  const chat = db.prepare(`SELECT id, title, created_at, updated_at FROM chats WHERE id = ? AND user_id = ?`).get(id, u.id);
  if (!chat) return reply.code(404).send({ error: '会话不存在' });
  const rows = db.prepare(`SELECT id, role, content, created_at FROM chat_messages WHERE chat_id = ? ORDER BY id`).all(id);
  const messages = rows.map((m) => {
    let c; try { c = JSON.parse(m.content); } catch { c = { text: '' }; }
    return { id: m.id, role: m.role, ...c };
  });
  return { chat, messages };
});

app.put('/api/chats/:id', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const { title } = req.body || {};
  if (!title || !title.trim()) return reply.code(400).send({ error: 'title 必填' });
  const r = db.prepare(`UPDATE chats SET title = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
    .run(title.trim().slice(0, 80), +req.params.id, u.id);
  if (!r.changes) return reply.code(404).send({ error: '会话不存在' });
  return { ok: true };
});

app.delete('/api/chats/:id', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const r = db.prepare(`DELETE FROM chats WHERE id = ? AND user_id = ?`).run(+req.params.id, u.id);
  if (!r.changes) return reply.code(404).send({ error: '会话不存在' });
  return { ok: true };
});

app.post('/api/chats/:id/send', async (req, reply) => {
  const u = requireUser(req, reply); if (!u) return;
  const chatId = +req.params.id;
  const chat = db.prepare(`SELECT id, title FROM chats WHERE id = ? AND user_id = ?`).get(chatId, u.id);
  if (!chat) return reply.code(404).send({ error: '会话不存在' });
  const { text, images } = req.body || {};
  const userText = typeof text === 'string' ? text.trim() : '';
  const userImgs = Array.isArray(images) ? images.filter((s) => typeof s === 'string') : [];
  if (!userText && !userImgs.length) return reply.code(400).send({ error: 'text 或 images 至少一项' });

  const cfg = getApiConfig();
  if (!cfg.llm.url || !cfg.llm.key || !cfg.llm.model) {
    return reply.code(503).send({ error: '系统暂未配置大语言模型 API。请联系管理员。' });
  }

  // Persist user message first so it's recorded even if upstream fails
  db.prepare(`INSERT INTO chat_messages (chat_id, role, content) VALUES (?, 'user', ?)`)
    .run(chatId, JSON.stringify({ text: userText, images: userImgs }));

  const history = db.prepare(`SELECT role, content FROM chat_messages WHERE chat_id = ? ORDER BY id`).all(chatId);
  const llmMessages = [{ role: 'system', content: buildExpertSystemPrompt() }, ...chatToLLMMessages(history)];

  let replyText = '';
  try {
    const resp = await fetch(cfg.llm.url.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.llm.key}` },
      body: JSON.stringify({ model: cfg.llm.model, messages: llmMessages, stream: false }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return reply.code(502).send({ error: `上游 ${resp.status}：${t.slice(0, 300)}` });
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return reply.code(502).send({ error: '上游返回为空' });
    const tokens = data?.usage?.total_tokens || 0;
    db.prepare(`INSERT INTO usage_log (user_id, kind, tokens) VALUES (?, 'chat', ?)`).run(u.id, tokens);
    replyText = typeof content === 'string' ? content : JSON.stringify(content);
    replyText = await processInlineImages(replyText, u.id);
  } catch (e) {
    return reply.code(502).send({ error: '上游网络错误：' + e.message });
  }

  // Persist assistant reply
  db.prepare(`INSERT INTO chat_messages (chat_id, role, content) VALUES (?, 'assistant', ?)`)
    .run(chatId, JSON.stringify({ text: replyText }));

  // Auto-derive title from first user message + bump updated_at
  if (chat.title === '新会话' && userText) {
    const t = userText.replace(/\s+/g, ' ').slice(0, 30);
    db.prepare(`UPDATE chats SET title = ?, updated_at = datetime('now') WHERE id = ?`).run(t, chatId);
  } else {
    db.prepare(`UPDATE chats SET updated_at = datetime('now') WHERE id = ?`).run(chatId);
  }

  return { reply: replyText };
});

// ===== Health =====
app.get('/api/health', async () => ({ ok: true, version: 'v0.4-backend', time: new Date().toISOString() }));

// ===== Start =====
loadCompliance();
try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`baize-api listening on ${HOST}:${PORT}`);
} catch (e) {
  app.log.error(e);
  process.exit(1);
}
