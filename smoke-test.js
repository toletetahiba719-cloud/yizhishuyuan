#!/usr/bin/env node
/**
 * 一纸书缘 · 上线自检（部署到服务器后、活动开始前跑一次）
 *
 * 用法：
 *   node smoke-test.js                                  # 测本机 8080
 *   node smoke-test.js https://your.domain.com          # 测线上（推荐）
 *   node smoke-test.js https://your.domain.com 管理员密码  # 额外测管理后台
 *
 * 这个脚本默认是只读的：不提交、不修改、不删除任何数据。
 * 它对线上环境安全，可以随时跑。
 */
'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const ADMIN_PW = process.env.ADMIN_PASSWORD || process.argv[3] || '';
if (!/^https?:\/\//.test(BASE)) {
  console.error('✗ 地址要以 http:// 或 https:// 开头');
  process.exit(1);
}
const target = new URL(BASE);
const lib = target.protocol === 'https:' ? https : http;
const PORT = target.port || (target.protocol === 'https:' ? 443 : 80);

let pass = 0, fail = 0, warn = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : JSON.stringify(extra)); }
};
const warnOk = (n) => { warn++; console.log('  ⚠', n); };

function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const t0 = Date.now();
    const r = lib.request({
      protocol: target.protocol, hostname: target.hostname, port: PORT, path, method,
      headers: Object.assign({ 'Accept-Encoding': 'gzip' }, headers || {},
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let decoded = buf;
        if (res.headers['content-encoding'] === 'gzip') {
          try { decoded = zlib.gunzipSync(buf); } catch (e) { /* 留给断言去发现 */ }
        }
        let json = null;
        try { json = JSON.parse(decoded.toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, buf, decoded, json, ms: Date.now() - t0 });
      });
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('请求超时')));
    if (data) r.write(data);
    r.end();
  });
}

// 发一个畸形请求，验证服务器不会被打崩（这是老版本真实存在过的崩溃点）
function rawRequest(line) {
  return new Promise((resolve) => {
    let s = null, done = false, got = '';
    const finish = (v) => { if (done) return; done = true; if (s) s.destroy(); resolve(v); };
    const connect = target.protocol === 'https:' ? tls.connect : net.connect;
    const options = { host: target.hostname, port: PORT };
    if (target.protocol === 'https:') options.servername = target.hostname;
    s = connect(options, () => {
      s.write(line + '\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
    s.setTimeout(4000, () => finish(got ? got.split('\r\n')[0] : '（无响应，但进程存活）'));
    s.on('data', d => {
      got += d.toString();
      const nl = got.indexOf('\r\n');     // 拿到状态行就够了，不必等完整响应
      if (nl !== -1) finish(got.slice(0, nl));
    });
    s.on('close', () => finish(got ? got.split('\r\n')[0] : '（无响应，但进程存活）'));
    s.on('error', e => finish('连接错误 ' + (e.code || e.message)));
  });
}

(async () => {
  console.log('');
  console.log(`  一纸书缘 · 上线自检  →  ${BASE}`);
  console.log('');

  // ── 1. 站点可用 ──
  try {
    const r = await req('GET', '/');
    ok('首页可访问（HTTP 200）', r.status === 200, r.status);
    ok('返回的是 HTML', /text\/html/.test(r.headers['content-type'] || ''), r.headers['content-type']);
    const body = r.decoded.toString('utf8');
    ok('页面内容完整（含前端的 apiFetch 逻辑）', body.includes('一纸书缘') && body.includes('apiFetch'));
    ok('HTML 开启了 gzip 压缩', r.headers['content-encoding'] === 'gzip',
       r.headers['content-encoding'] || '未压缩（小流量可接受，但费流量）');
    if (r.headers['content-encoding'] === 'gzip') {
      const ratio = Math.round(r.buf.length / r.decoded.length * 100);
      console.log(`      HTML ${r.decoded.length} → ${r.buf.length} 字节（${ratio}%），耗时 ${r.ms}ms`);
    }
  } catch (e) {
    ok('首页可访问', false, e.message);
    console.log('\n  ✗ 连首页都打不开，后面不用测了。检查：服务是否在跑 / 端口是否放行 / 域名是否解析。');
    process.exit(1);
  }

  // ── 2. 接口 ──
  const h = await req('GET', '/api/health');
  ok('/api/health 正常', h.status === 200 && h.json && h.json.ok === true, h.json);
  if (h.json) {
    console.log(`      共 ${h.json.count} 条，已通过 ${h.json.approved} 条，已运行 ${h.json.uptime}s`);
    if (h.json.approved > 800) {
      warnOk(`已通过 ${h.json.approved} 条，公开页全量下发，建议评估分页与手机端加载速度`);
    }
  }
  ok('/api/health 不可缓存（离线横幅才能恢复）', (h.headers['cache-control'] || '').includes('no-store'), h.headers['cache-control']);

  const notes = await req('GET', '/api/notes');
  ok('/api/notes 返回裸数组（前端契约）', notes.status === 200 && Array.isArray(notes.json), typeof notes.json);
  ok('/api/notes 不泄露 QQ（心得墙不显示 QQ）',
     Array.isArray(notes.json) && notes.json.length > 0 ? !('qq' in notes.json[0]) : true,
     Array.isArray(notes.json) && notes.json[0] ? Object.keys(notes.json[0]) : '空数组');
  ok('/api/notes 不可缓存（避免野生 304 打挂前端）', (notes.headers['cache-control'] || '').includes('no-store'), notes.headers['cache-control']);

  const pool = await req('GET', '/api/draw/pool');
  ok('/api/draw/pool 返回裸数组', pool.status === 200 && Array.isArray(pool.json));
  ok('拆信池保留 QQ（前端要显示，表单已告知会公开）',
     Array.isArray(pool.json) && pool.json.length > 0 ? 'qq' in pool.json[0] : true);

  // 公开接口只应含 approved
  const badStatus = Array.isArray(pool.json) ? pool.json.filter(n => n.status !== 'approved') : [];
  ok('公开接口只含已通过的心得（未审核绝不外泄）', badStatus.length === 0, badStatus.slice(0, 2));

  // ── 3. 崩溃回归测试 ──
  console.log('');
  console.log('  ── 崩溃回归测试（老版本会被这几个请求打挂）──');
  const attacks = ['GET http://[ HTTP/1.1', 'GET http://[::1 HTTP/1.1', 'GET //[ HTTP/1.1', 'GET http://% HTTP/1.1'];
  const results = [];
  for (const a of attacks) results.push(await rawRequest(a));
  const alive = await req('GET', '/api/health').catch(() => null);
  ok('畸形请求之后服务器仍然存活', alive && alive.status === 200);
  results.forEach((r, i) => {
    const is400 = /400|404/.test(r);
    console.log(`      ${is400 ? '✓' : '·'} ${attacks[i]} → ${r}`);
  });

  // ── 4. 管理后台（给了密码才测）──
  console.log('');
  if (!ADMIN_PW) {
    console.log('  · 未提供管理员密码，跳过后台测试（要测：node smoke-test.js ' + BASE + ' 你的密码）');
    console.log('  · 密码在服务器上：sudo cat /etc/yizishuyu.env');
  } else {
    const bad = await req('POST', '/api/login', { password: 'definitely-wrong-' + Date.now() });
    ok('错误密码被拒（401）', bad.status === 401, bad.status);
    const login = await req('POST', '/api/login', { password: ADMIN_PW });
    ok('管理员登录成功', login.status === 200 && login.json && login.json.token, login.status);
    if (login.json && login.json.token) {
      const auth = { Authorization: 'Bearer ' + login.json.token };
      const list = await req('GET', '/api/admin/notes', undefined, auth);
      ok('后台能拉到完整列表（裸数组）', list.status === 200 && Array.isArray(list.json));
      if (Array.isArray(list.json) && list.json.length > 1) {
        const ids = list.json.map(n => Number(n.id));
        ok('id 全部是数字（前端要拼进 onclick）', ids.every(Number.isFinite));
        ok('id 唯一（否则审核会改错行）', new Set(ids).size === ids.length);
        ok('列表按旧→新升序（前端会 reverse，编号就是顺序）',
           ids.every((v, i) => i === 0 || v > ids[i - 1]));
      }
      const noAuth = await req('GET', '/api/admin/notes');
      ok('无 token 访问后台返回 401（前端据此登出）', noAuth.status === 401, noAuth.status);
      const logout = await req('POST', '/api/admin/logout', {}, auth);
      const revoked = await req('GET', '/api/admin/notes', undefined, auth);
      ok('退出后旧 token 失效', logout.status === 200 && revoked.status === 401);
    }
  }

  // ── 5. 性能抽样 ──
  console.log('');
  const samples = [];
  for (let i = 0; i < 5; i++) samples.push((await req('GET', '/api/notes')).ms);
  samples.sort((a, b) => a - b);
  const worst = samples[samples.length - 1];
  ok(`接口响应够快（最慢 ${worst}ms，前端 8000ms 才超时）`, worst < 2000, worst);
  if (worst > 500) warnOk('响应偏慢，若学生反馈转圈请检查带宽或已通过条数');

  console.log('');
  console.log(`  ── 结果：${pass} 通过 / ${fail} 失败${warn ? ` / ${warn} 提醒` : ''} ──`);
  if (fail === 0) console.log('  ✓ 只读接口自检通过。完整投递流程与微信真机仍需验证。');
  console.log('');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n  自检异常：', e.message); process.exit(2); });
