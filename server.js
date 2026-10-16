/**
 * 一纸书缘 · 零依赖 Node 服务器
 * 运行：node server.js   （或 npm start）
 *
 * 设计要点：
 * - 只用 Node 内置模块（http/fs/crypto/zlib），无需 npm install
 * - 数据以内存为准：启动时把 data/notes.json 读进内存，之后所有读取都是内存操作
 *   每次变更写 tmp → fsync → 备份上一版 → 原子替换，保存成功才响应
 * - 并发铁律：await 之后到响应结束之间必须全程同步。push / byId.set / version++ /
 *   去重表写入 中间绝不能出现 await，否则会发出"半更新状态"的响应
 * - URL 永不触达文件系统路径（路由白名单），结构性防目录穿越
 * - 管理会话：内存 token（12h 滑动过期），重启后需重新登录（可接受）
 * - 公开接口只返回 approved 的心得；pending / rejected 绝不外泄
 *   拆信池含 QQ（前端会显示，且表单已告知会公开）；心得墙不含 QQ
 * - 限流面向"校园 NAT"现实：默认不做 per-IP 提交限制（几百人共用一个出口 IP，
 *   按 IP 限流会把全校锁死），改用内容去重 + 全局令牌桶 + 先审后公开
 */
'use strict';

// Node 18 以下没有 server.requestTimeout，断连客户端会永久占坑
const NODE_MAJOR = parseInt(process.versions.node.split('.')[0], 10);
if (NODE_MAJOR < 18) {
  console.error(`\n  ✗ 需要 Node.js 18 或更高版本，当前是 ${process.versions.node}。`);
  console.error('    请升级 Node（部署脚本会自动安装 Node 24）。\n');
  process.exit(1);
}

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// ── 配置 ────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.BIND_HOST || '127.0.0.1'; // 公网通过 nginx 提供服务
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const PREV_FILE = NOTES_FILE + '.prev';       // 完整上一版（rename 轮转，不是第二次全量写）
const TMP_FILE = NOTES_FILE + '.tmp';
const RECOVERY_FILE = path.join(DATA_DIR, 'recovery-required');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin888';
if (process.env.NODE_ENV === 'production' && (!process.env.ADMIN_PASSWORD || ADMIN_PASSWORD.length < 16 || ADMIN_PASSWORD === 'admin888')) {
  console.error('生产环境必须设置至少 16 位的独立 ADMIN_PASSWORD。');
  process.exit(1);
}
const RATE_LIMIT_PER_HOUR = parseInt(process.env.RATE_LIMIT_PER_HOUR || '0', 10); // 0 = 关闭（默认）
const MAX_NOTES = parseInt(process.env.MAX_NOTES || '5000', 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535 || !Number.isInteger(MAX_NOTES) || MAX_NOTES < 1 || !Number.isInteger(RATE_LIMIT_PER_HOUR) || RATE_LIMIT_PER_HOUR < 0) {
  console.error('PORT、MAX_NOTES 或 RATE_LIMIT_PER_HOUR 配置不合法');
  process.exit(1);
}
const MAX_BODY = 32 * 1024;                   // 32KB 字节，真实提交 < 4KB
const TZ = 'Asia/Shanghai';                   // 云服务器默认 UTC，时间统一按北京时间生成
const SESSION_TTL = 12 * 3600 * 1000;         // 12h 滑动过期
const LOGIN_FAIL_DELAY = 300;                 // 配合登录限流使用
const LOGIN_WARN_AT = 20;                     // 累计失败超过这个数就在日志里告警
const DEDUPE_WINDOW = 10 * 60 * 1000;         // 同样的内容 10 分钟内重复提交视为重复
const DEDUPE_MAX = 5000;                      // 去重表上限，防止无限增长
const GLOBAL_BURST = 200;                     // 全局令牌桶容量：要能容纳"一个教室同时提交"
const GLOBAL_REFILL = 50;                     // 每秒补充令牌数：远超真人手速，仍挡得住机器人
const GZIP_LEVEL = 4;                         // 实测比 level 6 快一倍，体积只多 1KB
const TRUST_PROXY = process.env.TRUST_PROXY === '1';   // 前置 nginx 时开启
const LOG_ACCESS = process.env.LOG_ACCESS === '1';     // 默认不打每请求日志
const APPROVED_WARN = 800;                    // 已通过条数超过它就在日志里提醒
const BOOT_ID = crypto.randomBytes(4).toString('hex'); // 每次启动唯一，避免重启后误判 304

// ── 启动横幅需要的早退检查 ──────────────────────────────────
const VALID_STATUS = ['pending', 'approved', 'rejected'];

function log(...a) { console.log(...a); }
function warn(...a) { console.warn(...a); }

// ── 数据装载 ────────────────────────────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true });

// 单条记录归一化：字段顺序固定（JSON 输出稳定），非法条目丢弃
function normalizeNote(n) {
  if (!n || typeof n !== 'object') return null;
  const id = Number(n.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    name: String(n.name == null ? '' : n.name),
    book: String(n.book == null ? '' : n.book),
    author: String(n.author == null ? '' : n.author),
    content: String(n.content == null ? '' : n.content),
    qq: String(n.qq == null ? '' : n.qq),
    status: VALID_STATUS.includes(n.status) ? n.status : 'pending',
    time: String(n.time == null ? '' : n.time)
  };
}

// 无法解析的文件不删除，改名留证据——绝不能让一次坏启动把历史数据抹掉
function quarantine(file) {
  const dest = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, dest);
    warn(`  已把无法解析的 ${path.basename(file)} 另存为 ${path.basename(dest)}（原文件保留，未删除）`);
  } catch (e) {
    warn(`  ⚠ 无法重命名 ${path.basename(file)}：${e.message}`);
  }
}

function loadStore() {
  const candidates = [NOTES_FILE, PREV_FILE, TMP_FILE];
  let degraded = fs.existsSync(RECOVERY_FILE);

  for (let i = 0; i < candidates.length; i++) {
    const file = candidates[i];
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') { warn(`  ⚠ 读取 ${path.basename(file)} 失败：${e.message}`); degraded = true; }
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('顶层不是数组');
      const clean = [];
      const ids = new Set();
      for (const item of parsed) {
        const n = normalizeNote(item);
        if (n && !ids.has(n.id)) { clean.push(n); ids.add(n.id); }
      }
      if (parsed.length > 0 && clean.length === 0) throw new Error('没有任何有效记录');
      if (clean.length !== parsed.length) {
        warn(`  ⚠ ${path.basename(file)} 中有 ${parsed.length - clean.length} 条记录格式非法，已跳过`);
        degraded = true;
      }
      if (i > 0) {
        warn(`  ⚠ 从备份文件 ${path.basename(file)} 恢复了 ${clean.length} 条数据`);
        degraded = true;
      }
      clean.sort((a, b) => a.id - b.id);
      return { notes: clean, degraded };
    } catch (e) {
      warn(`  ✗ ${path.basename(file)} 无法解析：${e.message}`);
      quarantine(file);
      degraded = true;
    }
  }

  if (degraded) {
    // 隔离坏文件后，下次 systemd 重启仍必须停下；不能把缺失文件当成首次空库。
    try { fs.writeFileSync(RECOVERY_FILE, '请恢复有效的 notes.json 后重新启动\n', { mode: 0o600 }); } catch (e) { warn(e.message); }
    throw new Error('所有数据文件都不可用，停止启动以免覆盖历史数据；请从备份恢复。');
  }
  return { notes: [], degraded };
}

const loaded = loadStore();

// ── 内存状态 ────────────────────────────────────────────────
let notes = loaded.notes;
let byId = new Map();
let version = 1;          // 任何逻辑变更都 ++，缓存按它失效
let lastId = 0;

for (const n of notes) {
  byId.set(n.id, n);
  if (n.id > lastId) lastId = n.id;
}

// id 必须保持"数字 + 唯一 + 递增"（前端 Number(n.id) 后拼进内联 onclick）
// 用 Math.max 兜住时钟回拨，且不再做 O(n) 扫描
function nextId() {
  const t = Date.now();
  lastId = t > lastId ? t : lastId + 1;
  return lastId;
}

function countApproved() {
  let n = 0;
  for (const x of notes) if (x.status === 'approved') n++;
  return n;
}

// ── 快照落盘 ────────────────────────────────────────────────
let lastSnapshot = { at: 0, bytes: 0, ms: 0 };

function writeSnapshotSync(json) {
  const t0 = Date.now();
  const fd = fs.openSync(TMP_FILE, 'w', 0o600);
  try {
    fs.writeFileSync(fd, json, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // 主文件始终留在原处，备份完整后再原子替换主文件。
  try {
    fs.copyFileSync(NOTES_FILE, PREV_FILE + '.tmp');
    fs.renameSync(PREV_FILE + '.tmp', PREV_FILE);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  fs.renameSync(TMP_FILE, NOTES_FILE);
  // Linux 上同步目录项，Windows 不支持目录 fsync。
  if (process.platform !== 'win32') {
    try {
      const dir = fs.openSync(DATA_DIR, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch (e) { warn(`  ⚠ 目录同步失败：${e.message}`); }
  }
  lastSnapshot = { at: Date.now(), bytes: Buffer.byteLength(json), ms: Date.now() - t0 };
}

// 几百人分批提交：每次变更先落盘再返回成功，退出时没有未保存队列。
// 磁盘满/权限错误时恢复内存，绝不返回虚假的成功。
function commitChange(change) {
  const before = notes.map(n => ({ ...n }));
  const beforeId = lastId;
  try {
    change();
    writeSnapshotSync(JSON.stringify(notes));
  } catch (e) {
    notes = before;
    lastId = beforeId;
    byId = new Map(notes.map(n => [n.id, n]));
    throw Object.assign(new Error('保存失败，请稍后重试或联系管理员'), { status: 503, cause: e });
  }
  version++;
}

// 首次启动创建空文件；从备份恢复时立即写回主文件。
if (loaded.degraded || !fs.existsSync(NOTES_FILE)) writeSnapshotSync(JSON.stringify(notes));
if (fs.existsSync(RECOVERY_FILE)) fs.unlinkSync(RECOVERY_FILE);

// ── 读路径缓存（按 version 惰性重建）────────────────────────
// ⚠ 这里刻意*不*给 API 响应加 ETag/304。原因（实测结论，别改回去）：
//   前端的 apiFetch 用 fetch() 读接口，一旦 304 真的到达 JS（浏览器缓存层没
//   按 RFC 9111 合成 200），res.ok 就是 false → 页面直接显示"请求失败"。
//   在主流 Chrome 上缓存层会正确处理，但本项目的目标是微信内置浏览器
//   （安卓 X5 内核 / iOS WKWebView），其缓存行为不可控也无法本地验证，
//   而压缩后这些响应只有 6–7KB，省这点流量不值得赌整页白屏。
//   index.html 的 304 保留——那是浏览器"导航"路径，通用且绝对可靠，
//   且它才是最大的单个文件（64KB → gzip 19KB）。
let cache = { version: 0, corner: null, pool: null, admin: null };

function makeRep(json) {
  const jsonBuf = Buffer.from(json, 'utf8');
  return {
    json: jsonBuf,
    gz: zlib.gzipSync(jsonBuf, { level: GZIP_LEVEL })
  };
}

function ensureCache() {
  if (cache.version === version) return;
  const approved = [];
  for (const n of notes) if (n.status === 'approved') approved.push(n);

  // 心得墙不含 QQ（前端心得墙不显示 QQ）；拆信池含 QQ（表单已告知会公开）
  const cornerArr = approved.map(n => ({
    id: n.id, name: n.name, book: n.book, author: n.author,
    content: n.content, status: n.status, time: n.time
  }));

  cache = {
    version,
    corner: makeRep(JSON.stringify(cornerArr)),
    pool: makeRep(JSON.stringify(approved)),
    admin: makeRep(JSON.stringify(notes))
  };
}

// ── 静态页 ──────────────────────────────────────────────────
const HTML_FILE = path.join(__dirname, 'index.html');
let htmlRep = null;
try {
  const raw = fs.readFileSync(HTML_FILE);
  htmlRep = {
    json: raw,
    gz: zlib.gzipSync(raw, { level: GZIP_LEVEL }),
    // 内容哈希：重启后 ETag 不变，学生浏览器可以继续用 304
    etag: `W/"${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16)}"`
  };
} catch (e) {
  htmlRep = null;
}

// ── 会话（内存）─────────────────────────────────────────────
const sessions = new Map(); // token → { at, last }
const rateMap = new Map();  // ip → { n, resetAt }（可选的 per-IP 提交限流）
let loginFails = 0;         // 全局失败计数：只有一个管理员，按 IP 只会自锁

function newSession() {
  if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(token, { at: now, last: now });
  return token;
}

function authed(req) {
  const m = /^Bearer\s+(\w+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const s = sessions.get(m[1]);
  if (!s) return false;
  if (Date.now() - s.last > SESSION_TTL) { sessions.delete(m[1]); return false; }
  s.last = Date.now(); // 滑动续期
  return true;
}

// 定时比较，避免通过响应时间反推密码
const PWD_HASH = crypto.createHash('sha256').update(String(ADMIN_PASSWORD)).digest();
function passwordOk(input) {
  const h = crypto.createHash('sha256').update(String(input == null ? '' : input)).digest();
  return crypto.timingSafeEqual(h, PWD_HASH);
}

// ── 客户端 IP ───────────────────────────────────────────────
function cleanIp(s) {
  s = String(s || '').trim();
  if (!s || s.length > 64 || /^unknown$/i.test(s)) return '';
  if (s[0] === '[') {                       // [2001:db8::1]:443
    const end = s.indexOf(']');
    if (end > 0) s = s.slice(1, end);
    return s.replace(/^::ffff:/, '');
  }
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s);   // 1.2.3.4:5678
  if (m) s = m[1];
  return s.replace(/^::ffff:/, '');
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) {
      // 只有一层可信代理（nginx）：它追加的最后一个跳才是真实客户端
      const parts = xff.split(',');
      const ip = cleanIp(parts[parts.length - 1]);
      if (ip) return ip;
    }
  }
  return cleanIp(req.socket.remoteAddress) || '?';
}

// ── 限流 ────────────────────────────────────────────────────
// 全局令牌桶：只防"机器人刷接口"，不针对个人。校园 NAT 下 per-IP 限流毫无意义。
let tokens = GLOBAL_BURST;
let lastRefill = Date.now();

function globalAllow() {
  const now = Date.now();
  tokens = Math.min(GLOBAL_BURST, tokens + ((now - lastRefill) / 1000) * GLOBAL_REFILL);
  lastRefill = now;
  if (tokens < 1) return false;
  tokens -= 1;
  return true;
}

function allow(map, ip, limit, windowMs) {
  const now = Date.now();
  const e = map.get(ip);
  if (!e || now > e.resetAt) { map.set(ip, { n: 1, resetAt: now + windowMs }); return true; }
  if (e.n >= limit) return false;
  e.n++;
  return true;
}

// ── 内容去重（挡住双击/重试造成的重复提交）─────────────────
const dedupe = new Map(); // hash → { id, at }（只存 id，不存对象引用）

function dedupeKey(v) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([v.name, v.book, v.author, v.content, v.qq]))
    .digest('hex').slice(0, 16);
}

function dedupeHit(key) {
  const e = dedupe.get(key);
  if (!e) return null;
  if (Date.now() - e.at > DEDUPE_WINDOW) { dedupe.delete(key); return null; }
  return e;
}

for (const n of notes) {
  if (Date.now() - n.id >= 0 && Date.now() - n.id < DEDUPE_WINDOW) {
    dedupe.set(dedupeKey(n), { id: n.id, at: n.id });
  }
}

// 只对管理员登录限流，不影响共用校园出口 IP 的普通学生提交。
const loginRateMap = new Map();
let loginTokens = 10;
let loginRefill = Date.now();
function loginAllow(ip) {
  const now = Date.now();
  loginTokens = Math.min(10, loginTokens + (now - loginRefill) / 1000);
  loginRefill = now;
  if (loginTokens < 1 || !allow(loginRateMap, ip, 10, 60000)) return false;
  loginTokens--;
  return true;
}

function sweep() {
  const now = Date.now();
  for (const [t, s] of sessions) if (now - s.last > SESSION_TTL) sessions.delete(t);
  for (const [ip, e] of rateMap) if (now > e.resetAt) rateMap.delete(ip);
  for (const [ip, e] of loginRateMap) if (now > e.resetAt) loginRateMap.delete(ip);
  for (const [k, e] of dedupe) if (now - e.at > DEDUPE_WINDOW) dedupe.delete(k);
  if (rateMap.size > 10000) rateMap.clear();
  if (dedupe.size > DEDUPE_MAX) {
    // Map 保持插入顺序，从最旧的开始删
    const excess = dedupe.size - DEDUPE_MAX;
    let i = 0;
    for (const k of dedupe.keys()) { dedupe.delete(k); if (++i >= excess) break; }
  }
}
setInterval(sweep, 5 * 60 * 1000);

// ── 请求体 ──────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', c => {
      if (done) return;
      size += c.length; // Buffer.length = 字节数
      if (size > MAX_BODY) { done = true; reject(Object.assign(new Error('请求体过大'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        const data = Buffer.concat(chunks).toString('utf8');
        const parsed = data ? JSON.parse(data) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('需要 JSON 对象');
        resolve(parsed);
      }
      catch (e) { reject(Object.assign(new Error('JSON 解析失败'), { status: 400 })); }
    });
    req.on('error', e => { if (!done) { done = true; reject(Object.assign(e, { status: 400 })); } });
    req.on('aborted', () => { if (!done) { done = true; reject(Object.assign(new Error('请求中断'), { status: 400 })); } });
  });
}

// 读体失败 → 回错误并返回 null；413 时等响应发完再断连接，保证客户端收得到提示
function bodyOrFail(req, res) {
  return readBody(req).catch(e => {
    sendJson(res, e.status || 400, { error: e.status === 413 ? '内容太大啦' : '请求格式错误' });
    if (e.status === 413) res.on('finish', () => req.destroy());
    return null;
  });
}

// ── 校验（与前端一致）────────────────────────────────────────
function validateNote(body) {
  for (const key of ['name', 'book', 'author', 'content', 'qq']) {
    if (body[key] !== undefined && typeof body[key] !== 'string') return { err: '表单字段必须是文本' };
  }
  const name = String(body.name || '').trim();
  const book = String(body.book || '').trim();
  const author = String(body.author || '').trim();
  const content = String(body.content || '').trim();
  const qq = String(body.qq || '').trim();
  if (!name) return { err: '请填写你的姓名 😊' };
  if (name.length > 20) return { err: '姓名太长啦，20 字以内' };
  if (!book) return { err: '请填写推荐的书名 📖' };
  if (book.length > 50) return { err: '书名太长啦，50 字以内' };
  if (content.length < 20) return { err: '心得内容至少写 20 字哦，多写一点吧！' };
  if (content.length > 2000) return { err: '心得太长啦，2000 字以内' };
  if (author.length > 30) return { err: '作者名太长啦，30 字以内' };
  if (qq && !/^\d{5,12}$/.test(qq)) return { err: 'QQ号看起来不太对哦，请检查一下～' };
  return { name, book, author, content, qq };
}

// ── 响应工具 ────────────────────────────────────────────────
function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, extraHeaders || {}));
  res.end(body);
}

// 带 gzip（+ 可选 ETag/304）的响应。
// 只有带 etag 的响应才走 304——目前仅 index.html（导航请求，缓存层处理绝对可靠）。
// API 一律 no-store，确保任何中间层都不可能把 304 交给前端的 fetch()。
// 注意：必须保留未压缩路径——老版微信 X5 内核不保证发送 Accept-Encoding；
//       缓存 Buffer 绝不原地修改（会污染并发中的响应）
function sendRep(req, res, rep, opts) {
  opts = opts || {};
  const headers = {
    'Content-Type': opts.contentType || 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Accept-Encoding'
  };

  if (rep.etag) {
    headers['ETag'] = rep.etag;
    headers['Cache-Control'] = 'no-cache';   // 存但每次校验：换版本后立刻生效
    if (req.headers['if-none-match'] === rep.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
  } else {
    headers['Cache-Control'] = 'no-store';
  }

  const acceptGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (acceptGzip) {
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = rep.gz.length;
    res.writeHead(200, headers);
    res.end(rep.gz);
  } else {
    headers['Content-Length'] = rep.json.length;
    res.writeHead(200, headers);
    res.end(rep.json);
  }
}

// ── 统计（默认不打每请求日志：负载下 journald 写入是最大的剩余阻塞点）──
const stats = { req: 0, err: 0, submit: 0, dup: 0, approved: 0, since: Date.now() };

function logStats() {
  if (!stats.req) return;
  server.getConnections((e, conns) => {
    const heap = Math.round(process.memoryUsage().heapUsed / 1048576);
    const secs = Math.round((Date.now() - stats.since) / 1000);
    log(`  [${new Date().toLocaleString('zh-CN', { timeZone: TZ, hour12: false })}] ` +
        `请求 ${stats.req}/${secs}s · 错误 ${stats.err} · 提交 ${stats.submit}(去重 ${stats.dup}) · ` +
        `连接 ${e ? '?' : conns} · 堆 ${heap}MB · 心得 ${notes.length} 条(已通过 ${countApproved()}) · ` +
        `快照 ${lastSnapshot.bytes ? Math.round(lastSnapshot.bytes / 1024) + 'KB/' + lastSnapshot.ms + 'ms' : '无'}`);
    stats.req = 0; stats.err = 0; stats.submit = 0; stats.dup = 0; stats.since = Date.now();
  });
}
setInterval(logStats, 60 * 1000);

function warnIfBacklog() {
  const approved = countApproved();
  if (approved > APPROVED_WARN) {
    warn(`  ⚠ 已通过 ${approved} 条，公开页全量下发，建议评估分页与手机端加载速度。`);
  }
}

// ── 路由 ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const start = Date.now();
  stats.req++;
  let p = '(unparsed)';
  let ip = '?';

  try {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    // ⚠ 解析 URL 必须在 try 内：畸形 URL 会抛异常，未捕获即进程崩溃
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch (e) {
      sendJson(res, 400, { error: '请求地址不合法' });
      return;
    }
    p = url.pathname;
    ip = clientIp(req);
    if (shuttingDown) { sendJson(res, 503, { error: '服务正在重启，请稍后再试' }); return; }
    if (['POST', 'DELETE'].includes(req.method)) {
      let foreignOrigin = req.headers['sec-fetch-site'] === 'cross-site';
      if (req.headers.origin) {
        try { foreignOrigin = foreignOrigin || new URL(req.headers.origin).host !== req.headers.host; }
        catch { foreignOrigin = true; }
      }
      if (foreignOrigin) { sendJson(res, 403, { error: '请通过本站页面操作' }); return; }
    }

    // 静态：白名单，URL 永不触达文件系统
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      if (!htmlRep) { sendJson(res, 500, { error: 'index.html 不存在' }); return; }
      sendRep(req, res, htmlRep, { contentType: 'text/html; charset=utf-8' });
      return;
    }
    if (req.method === 'GET' && p === '/favicon.ico') { res.writeHead(204); res.end(); return; }

    // ── 公开 API（只输出已审核通过的心得）──
    // 健康检查是"离线恢复通道"，不做任何限流；前端在离线时每 20s 轮询它
    if (p === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        count: notes.length,
        approved: countApproved(),
        uptime: Math.round(process.uptime())
      });
      return;
    }

    if (p === '/api/notes' && req.method === 'GET') {
      ensureCache();
      sendRep(req, res, cache.corner);   // 心得墙：不含 QQ
      return;
    }

    if (p === '/api/draw/pool' && req.method === 'GET') {
      ensureCache();
      sendRep(req, res, cache.pool);     // 拆信池：含 QQ（前端会显示）
      return;
    }

    if (p === '/api/notes' && req.method === 'POST') {
      // 先过全局令牌桶再读 body：被刷时不浪费带宽解析请求体
      if (!globalAllow()) {
        stats.err++;
        sendJson(res, 429, { error: '现在提交的人有点多，请稍等几秒再试～' });
        return;
      }
      // per-IP 限流默认关闭；校园 NAT 下开启会把全校锁死，仅在需要时通过环境变量打开
      if (RATE_LIMIT_PER_HOUR > 0 && !allow(rateMap, ip, RATE_LIMIT_PER_HOUR, 3600 * 1000)) {
        stats.err++;
        sendJson(res, 429, { error: '提交太频繁啦，请稍后再试～' });
        return;
      }

      const body = await bodyOrFail(req, res);
      if (body === null) return;
      const v = validateNote(body);
      if (v.err) { stats.err++; sendJson(res, 400, { error: v.err }); return; }

      // ↓↓↓ 从这里到 sendJson 必须全程同步，中间不能有任何 await ↓↓↓
      const key = dedupeKey(v);
      const duplicate = dedupeHit(key);
      if (duplicate && byId.has(duplicate.id)) {
        stats.dup++;
        sendJson(res, 200, { ok: true, id: duplicate.id });
        return;
      }
      if (notes.length >= MAX_NOTES) {
        stats.err++;
        sendJson(res, 429, { error: '信箱已满，请联系社团管理员' });
        return;
      }
      const note = {
        id: nextId(),
        name: v.name, book: v.book, author: v.author, content: v.content, qq: v.qq,
        status: 'pending', // 提交先入待审核，审核通过后才公开
        time: new Date().toLocaleString('zh-CN', { timeZone: TZ, hour12: false })
      };
      commitChange(() => { notes.push(note); byId.set(note.id, note); });
      dedupe.set(key, { id: note.id, at: Date.now() });
      // ↑↑↑ 同步块结束 ↑↑↑
      stats.submit++;
      sendJson(res, 201, { ok: true, id: note.id });
      return;
    }

    if (p === '/api/login' && req.method === 'POST') {
      if (!loginAllow(ip)) { sendJson(res, 429, { error: '登录尝试过于频繁，请一分钟后再试', }, { 'Retry-After': '60' }); return; }
      const body = await bodyOrFail(req, res);
      if (body === null) return;
      if (passwordOk(body.password)) {
        loginFails = 0;
        sendJson(res, 200, { token: newSession() });
      } else {
        // 登录限流 + 固定延迟 + 日志告警；不影响普通学生投递。
        loginFails++;
        if (loginFails === LOGIN_WARN_AT || loginFails % 100 === 0) {
          warn(`  ⚠ 管理员登录已连续失败 ${loginFails} 次（来源 ${ip}），请确认密码是否泄露或有人正在爆破`);
        }
        setTimeout(() => {
          if (!res.writableEnded) sendJson(res, 401, { error: '密码错误，请重试' });
        }, LOGIN_FAIL_DELAY);
      }
      return;
    }

    // ── 管理接口（需 Bearer token）──
    if (p.startsWith('/api/admin/')) {
      if (!authed(req)) { stats.err++; sendJson(res, 401, { error: '登录已过期，请重新登录' }); return; }

      if (p === '/api/admin/logout' && req.method === 'POST') {
        sessions.delete(req.headers.authorization.replace(/^Bearer\s+/, ''));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (p === '/api/admin/export' && req.method === 'GET') {
        const body = JSON.stringify(notes, null, 2);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Content-Disposition': 'attachment; filename="yizishuyu-export.json"',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(body);
        return;
      }

      if (p === '/api/admin/notes' && req.method === 'GET') {
        ensureCache();
        // 契约：完整、升序、不分页（前端自己 reverse + 算统计）
        sendRep(req, res, cache.admin);
        return;
      }

      const sm = /^\/api\/admin\/notes\/(\d+)\/status$/.exec(p);
      if (sm && req.method === 'POST') {
        const id = Number(sm[1]);
        const body = await bodyOrFail(req, res);
        if (body === null) return;
        const status = body.status;
        if (!VALID_STATUS.includes(status)) { stats.err++; sendJson(res, 400, { error: '非法状态' }); return; }
        // ↓ 同步块：查找 + 修改 + 版本推进
        const note = byId.get(id);
        if (!note) { stats.err++; sendJson(res, 404, { error: '这条心得不存在（可能已被删除）' }); return; }
        commitChange(() => { note.status = status; });
        // ↑ 同步块结束
        if (status === 'approved') { stats.approved++; warnIfBacklog(); }
        sendJson(res, 200, { ok: true });
        return;
      }

      const dm = /^\/api\/admin\/notes\/(\d+)$/.exec(p);
      if (dm && req.method === 'DELETE') {
        const id = Number(dm[1]);
        // ↓ 同步块：无 body，全程同步
        const note = byId.get(id);
        if (!note) { stats.err++; sendJson(res, 404, { error: '这条心得不存在（可能已被删除）' }); return; }
        commitChange(() => {
          byId.delete(id);
          const idx = notes.indexOf(note);
          if (idx !== -1) notes.splice(idx, 1);
        });
        dedupe.delete(dedupeKey(note));
        // ↑ 同步块结束
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    stats.err++;
    sendJson(res, 404, { error: '页面不存在' });
  } catch (e) {
    stats.err++;
    warn('  ✗', (e && e.stack) || e);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.status === 503 ? e.message : '服务器开小差了，请稍后再试' });
    else if (!res.writableEnded) res.end();
  } finally {
    if (LOG_ACCESS) {
      log(`  ${req.method} ${p} ${res.statusCode} ${ip} ${Date.now() - start}ms`);
    }
  }
});

// ── HTTP 调参 ───────────────────────────────────────────────
server.keepAliveTimeout = 5000;    // 保持默认：每个空闲连接实测 28–55KB 内存，不抬高
server.headersTimeout = 15000;     // 必须大于 keepAliveTimeout
server.requestTimeout = 30000;     // 默认 300s → 收紧，及时回收断连客户端
server.timeout = 0;
server.maxRequestsPerSocket = 0;
server.maxConnections = 6000;      // 兜底，超过会被 Node 断开（前端会显示离线横幅）
server.maxHeadersCount = 100;

server.on('connection', s => { try { s.setNoDelay(true); } catch (e) { /* 忽略 */ } });

server.on('clientError', (err, socket) => {
  // 畸形请求（含被防火墙/扫描器截断的）：回 400 并断开，绝不让它变成未捕获异常
  try {
    if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy();
  } catch (e) { socket.destroy(); }
});

server.on('error', (e) => {
  warn(`  ✗ 服务器错误：${e.code || ''} ${e.message}`);
  if (e.code === 'EADDRINUSE') {
    warn(`    端口 ${PORT} 已被占用，无法启动。`);
    process.exit(1);
  }
  // EMFILE/ENFILE（文件描述符耗尽）等错误不要让它变成未捕获异常
});

server.listen({ port: PORT, host: HOST, backlog: 1024 }, () => {
  log('');
  log('  ── 一纸书缘 ──');
  log(`  监听:       ${HOST}:${PORT}`);
  log(`  本机访问:   http://127.0.0.1:${PORT}`);
  log(`  数据:       ${NOTES_FILE}（${notes.length} 条，已通过 ${countApproved()}）`);
  log(`  启动编号:   ${BOOT_ID}`);
  log(`  限流:       全局 ${GLOBAL_REFILL}/秒（突发 ${GLOBAL_BURST}）` +
      (RATE_LIMIT_PER_HOUR > 0 ? ` · per-IP ${RATE_LIMIT_PER_HOUR} 次/小时` : ' · per-IP 限流已关闭'));
  log(`  日志:       ${LOG_ACCESS ? '完整访问日志' : '仅统计与错误（LOG_ACCESS=1 可开完整日志）'}`);
  if (TRUST_PROXY) log('  代理:       信任 X-Forwarded-For（仅在 nginx 反代后开启！）');
  if (loaded.degraded) warn('  ⚠ 本次启动是降级恢复，请检查上面的告警并把数据导出一份留档');
  if (ADMIN_PASSWORD === 'admin888') {
    warn('  ⚠ 未设置 ADMIN_PASSWORD，正在使用默认密码 admin888！');
    warn('    生产环境请通过 /etc/yizishuyu.env 设置（setup.sh 会自动生成随机密码）');
  }
  if (notes.length > 0 && !loaded.degraded) log('  ✓ 数据加载正常');
  log('');
});

// ── 退出与异常 ──────────────────────────────────────────────
let shuttingDown = false;

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`  收到 ${sig}，正在结束请求…`);

  const force = setTimeout(() => { warn('  ⚠ 关闭超时，强制退出'); process.exit(1); }, 8000);
  force.unref();

  server.close(() => {
    log('  ✓ 数据已保存，服务已停止。');
    process.exit(0);
  });
  if (server.closeIdleConnections) server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (e) => {
  warn('  ✗ 未捕获异常，进程将退出：', (e && e.stack) || e);
  // 已确认的操作已落盘，退出交给 systemd 重启。
  process.exit(1);
});

process.on('unhandledRejection', (e) => {
  // 只记日志不退出：路由内的异常已被 try/catch 覆盖，这里出现说明是意料外的情况。
  // 绝不在这里吞掉后继续跑"半个响应"——若真的出现，请按日志排查。
  warn('  ✗ 未处理的 Promise 拒绝：', (e && e.stack) || e);
});
