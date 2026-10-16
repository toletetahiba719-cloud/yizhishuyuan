#!/usr/bin/env node
/**
 * 一纸书缘 · 零依赖压测工具
 *
 * 用法：
 *   node loadtest.js                                  # 默认：本地 8080，200 并发
 *   node loadtest.js http://1.2.3.4:8080 500          # 500 并发各跑一轮
 *   node loadtest.js http://1.2.3.4:8080 500 --burst  # 500 个同时冷连接（模拟扫码爆发）
 *   node loadtest.js http://1.2.3.4:8080 200 --duration 300   # 持续压 5 分钟
 *   node loadtest.js http://127.0.0.1:8080 50 --submit 0.2    # 20% 的虚拟用户会提交
 *
 * ⚠ 会提交数据的模式（--submit）请只对测试实例使用：
 *     PORT=8099 DATA_DIR=/tmp/yzsy-test ADMIN_PASSWORD=x node server.js
 *
 * 判断标准：5xx 必须为 0；"超过 8 秒"必须为 0（前端 apiFetch 8 秒就放弃，
 * 学生看到的就是"请求超时"）。p99 越低越好。
 */
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

// ── 参数 ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const name = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[name] = next; i++; }
    else flags[name] = true;
  } else positional.push(a);
}

const BASE = positional[0] || 'http://127.0.0.1:8080';
const VUS = parseInt(positional[1] || '200', 10);
const DURATION = parseInt(flags.duration || '0', 10);   // 秒；0 = 每个虚拟用户跑一轮就结束
const BURST = !!flags.burst;
const SUBMIT_RATIO = parseFloat(flags.submit || '0');
const TIMEOUT = parseInt(flags.timeout || '20000', 10);
const QUIET = !!flags.quiet;

const CLIENT_TIMEOUT_MS = 8000;   // 前端 apiFetch 的超时阈值
const LAT_CAP = 200000;           // 每个接口最多保留多少条延迟样本（蓄水池抽样）

if (!/^https?:\/\//.test(BASE)) {
  console.error('✗ 地址要以 http:// 或 https:// 开头，例如 http://127.0.0.1:8080');
  process.exit(1);
}
if (!Number.isFinite(VUS) || VUS < 1 || VUS > 20000) {
  console.error('✗ 并发数要在 1–20000 之间');
  process.exit(1);
}

const target = new URL(BASE);
const lib = target.protocol === 'https:' ? https : http;

// 每个虚拟用户一条独立连接（真实手机各自一条 TCP），开 keep-alive 复用同一条
function makeAgent() {
  return new lib.Agent({ keepAlive: true, maxSockets: 2, keepAliveMsecs: 5000 });
}

// ── 统计 ────────────────────────────────────────────────────
const lat = {};          // path → [ms]
const sampleCounts = {};
const maxima = {};
const status = {};       // code → n
const errors = {};       // 类型 → n
let over8s = 0;
let done = 0;
let inFlight = 0;
let maxInFlight = 0;
const startedAt = Date.now();

function bump(map, key) { map[key] = (map[key] || 0) + 1; }

function request(agent, method, path, body) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const key = method + ' ' + path;
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path,
      method,
      agent,
      headers: Object.assign(
        { 'Accept-Encoding': 'gzip', 'Connection': 'keep-alive' },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}
      )
    }, (res) => {
      res.resume();   // 必须把响应读完，否则 keep-alive 连接无法复用
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        // 蓄水池抽样：长时间压测下延迟数组不能无限增长
        if (!lat[key]) lat[key] = [];
        sampleCounts[key] = (sampleCounts[key] || 0) + 1;
        maxima[key] = Math.max(maxima[key] || 0, ms);
        const a = lat[key];
        if (a.length < LAT_CAP) a.push(ms);
        else { const j = rand(sampleCounts[key]); if (j < LAT_CAP) a[j] = ms; }
        if (ms > CLIENT_TIMEOUT_MS) over8s++;
        bump(status, res.statusCode);
        done++; inFlight--;
        resolve();
      });
    });
    inFlight++;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    req.setTimeout(TIMEOUT, () => { req.destroy(new Error('TIMEOUT')); });
    req.on('error', (e) => {
      const kind = e.message === 'TIMEOUT' ? '超时' :
        (e.code === 'ECONNREFUSED' ? '连接被拒' :
        (e.code === 'ECONNRESET' ? '连接被重置' :
        (e.code === 'EMFILE' ? '本地文件描述符耗尽' : (e.code || e.message))));
      bump(errors, kind);
      done++; inFlight--;
      resolve();
    });
    if (payload) req.write(payload);
    req.end();
  });
}

const rand = (n) => Math.floor(Math.random() * n);
const CONTENT_POOL = [
  '这本书让我重新理解了什么叫克制，作者把一生的重量压进很轻的句子里。',
  '读到中段忽然被击中，原来最普通的日常才是作者真正想写的东西。',
  '关于告别的那一段写得极好，我抄在本子上了，推荐给正在迷茫的人。',
  '第一遍读故事，第二遍才读出那些沉默的部分，值得反复重读。',
  '合上书很久我还在想里面那句话，这大概就是好文学的样子。'
];

// 一个虚拟用户走一遍真实浏览路径。
// ⚠ deadline 为 0 表示"只跑一轮"，绝不能用 Infinity——那会让压测永远不结束
async function virtualUser(agent, vuIndex) {
  const deadline = DURATION ? startedAt + DURATION * 1000 : 0;
  do {
    await request(agent, 'GET', '/');
    await request(agent, 'GET', '/api/health');
    await request(agent, 'GET', '/api/notes');
    await request(agent, 'GET', '/api/draw/pool');
    if (SUBMIT_RATIO > 0 && Math.random() < SUBMIT_RATIO) {
      await request(agent, 'POST', '/api/notes', {
        name: `压测${vuIndex}`,
        book: '《压测用书》',
        author: '压测',
        content: CONTENT_POOL[rand(CONTENT_POOL.length)] + `（${vuIndex}-${rand(1e9)}）`,
        qq: ''
      });
    }
  } while (deadline && Date.now() < deadline);
}

// ── 主流程 ──────────────────────────────────────────────────
function pct(arr, p) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
const fmt = (n) => (n >= 100 ? String(Math.round(n)) : n.toFixed(1));

(async () => {
  console.log('');
  console.log(`  一纸书缘 · 压测  →  ${BASE}`);
  console.log(`  虚拟用户 ${VUS} · ${BURST ? '冷启动爆发模式（同时打）' : '同时起跑'} · ` +
              `${DURATION ? `持续 ${DURATION}s` : '各跑一轮'} · 提交比例 ${SUBMIT_RATIO}`);
  console.log('');

  // 先探活并看清目标数据量
  const probe = await new Promise((resolve) => {
    const req = lib.get(BASE + '/api/health', { timeout: 5000 }, (res) => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
  if (!probe || !probe.ok) {
    console.error('  ✗ 连不上或 /api/health 异常，先确认服务在跑');
    process.exit(1);
  }
  console.log(`  目标状态：共 ${probe.count} 条，已通过 ${probe.approved} 条`);
  if (probe.approved > 800) {
    console.log(`  ⚠ 已通过 ${probe.approved} 条，建议评估分页与手机端加载速度。`);
  }
  if (SUBMIT_RATIO > 0) console.log('  ⚠ 提交模式会写入数据，请确认目标是测试实例！');
  console.log('');

  const agents = [];
  const tasks = [];
  const t0 = Date.now();
  const ticker = QUIET ? null : setInterval(() => {
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(`\r  进行中 ${secs}s · 完成 ${done} 请求 · 在飞 ${inFlight}（峰值 ${maxInFlight}）   `);
  }, 500);

  for (let i = 0; i < VUS; i++) {
    const agent = makeAgent();
    agents.push(agent);
    tasks.push(virtualUser(agent, i));
    if (!BURST && i % 50 === 49) await new Promise(r => setTimeout(r, 15));  // 非爆发模式稍微错开
  }
  await Promise.all(tasks);
  if (ticker) clearInterval(ticker);
  const wall = (Date.now() - t0) / 1000;
  agents.forEach(a => a.destroy());
  process.stdout.write('\r' + ' '.repeat(70) + '\r');

  // ── 报告 ──
  const totalReq = Object.values(status).reduce((a, b) => a + b, 0) +
                   Object.values(errors).reduce((a, b) => a + b, 0);
  const s5xx = Object.keys(status).filter(c => c >= 500).reduce((a, c) => a + status[c], 0);
  const s4xx = Object.keys(status).filter(c => c >= 400 && c < 500).reduce((a, c) => a + status[c], 0);

  console.log('  ── 结果 ──');
  console.log(`  总请求 ${totalReq} · 耗时 ${wall.toFixed(1)}s · 吞吐 ${(totalReq / wall).toFixed(0)} 请求/秒`);
  console.log(`  峰值并发连接 ${maxInFlight}`);
  console.log('');
  console.log('  各接口延迟 (ms):');
  Object.keys(lat).forEach(p => {
    const a = lat[p];
    console.log(`    ${p.padEnd(16)} n=${String(a.length).padStart(6)}  ` +
                `p50=${fmt(pct(a, 0.5)).padStart(7)}  p95=${fmt(pct(a, 0.95)).padStart(7)}  ` +
                `p99=${fmt(pct(a, 0.99)).padStart(7)}  最大=${fmt(maxima[p]).padStart(7)}`);
  });
  console.log('');
  console.log('  状态码分布: ' + (Object.keys(status).length
    ? Object.entries(status).sort().map(([c, n]) => `${c}×${n}`).join('  ')
    : '（无成功响应）'));
  if (Object.keys(errors).length) {
    console.log('  错误分布:   ' + Object.entries(errors).map(([k, n]) => `${k}×${n}`).join('  '));
  }

  console.log('');
  const verdict = [];
  verdict.push(s5xx === 0 ? `  ✓ 无 5xx（服务器没有崩）` : `  ✗ 出现 ${s5xx} 个 5xx —— 服务器扛不住这个并发！`);
  verdict.push(over8s === 0 ? '  ✓ 无请求超过 8 秒（学生不会看到"请求超时"）'
                            : `  ✗ 有 ${over8s} 个请求超过 8 秒 —— 这些学生看到的是"请求超时"`);
  const slow = pct(lat['GET /api/notes'] || [], 0.95);
  if (slow) verdict.push(`  · /api/notes p95 = ${fmt(slow)}ms（前端阈值 8000ms，越远越安全）`);
  if (s4xx) verdict.push(`  · 有 ${s4xx} 个 4xx（若开了 --submit，429 属于限流正常工作）`);
  verdict.forEach(v => console.log(v));
  console.log('');
  process.exit(s5xx === 0 && over8s === 0 && Object.keys(errors).length === 0 && (SUBMIT_RATIO > 0 || s4xx === 0) ? 0 : 1);
})().catch(e => { console.error('\n  压测异常:', e.message); process.exit(2); });
