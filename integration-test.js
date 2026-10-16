#!/usr/bin/env node
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { once } = require('events');
const password = 'integration-only-password-32-characters';

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function start(dataDir) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), BIND_HOST: '127.0.0.1', DATA_DIR: dataDir, NODE_ENV: 'production', ADMIN_PASSWORD: password, TRUST_PROXY: '0', RATE_LIMIT_PER_HOUR: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', b => { log += b; });
  child.stderr.on('data', b => { log += b; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(log);
    try { if ((await fetch(base + '/api/health')).ok) return { child, base, port }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  child.kill();
  throw new Error('Server start timeout: ' + log);
}
async function stop(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exited = once(server.child, 'exit');
  server.child.kill('SIGTERM');
  await exited;
}
async function request(server, route, method = 'GET', body, token, headers = {}) {
  const res = await fetch(server.base + route, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000)
  });
  return { status: res.status, body: await res.json() };
}
const note = { name: '中文同学📚', book: '测试书名', author: '作者', content: '这是一段用于验证多人共享和中文完整保存的读书心得。'.repeat(4), qq: '123456789' };

test('校园活动完整流程（全部使用临时数据）', { timeout: 120000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yzsy-integration-'));
  const notesFile = path.join(dataDir, 'notes.json');
  let server = await start(dataDir);
  let id, token;
  try {
    await t.test('非法 JSON 对象和字段返回 400，不挂起或返回 500', async () => {
      for (const body of [null, [], true, 123, '文本', { ...note, name: {} }]) {
        assert.equal((await request(server, '/api/notes', 'POST', body)).status, 400);
      }
      assert.equal((await request(server, '/api/health')).status, 200);
    });
    await t.test('中文/emoji 跨 UTF-8 字节分包仍完整保存；成功时已落盘', async () => {
      const payload = Buffer.from(JSON.stringify(note));
      const split = payload.indexOf(Buffer.from('中')) + 1;
      const result = await new Promise((resolve, reject) => {
        const req = http.request(server.base + '/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } }, res => {
          let body = '';
          res.on('data', b => { body += b; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        });
        req.on('error', reject);
        req.write(payload.subarray(0, split));
        setTimeout(() => req.end(payload.subarray(split)), 30);
      });
      assert.equal(result.status, 201);
      id = result.body.id;
      const saved = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
      assert.equal(saved[0].name, note.name);
      assert.equal(saved[0].content, note.content);
    });
    await t.test('并发重复提交只保存一条，作者/QQ 不同不被误去重', async () => {
      const results = await Promise.all(Array.from({ length: 30 }, () => request(server, '/api/notes', 'POST', note)));
      assert.ok(results.every(r => r.status === 200 && r.body.id === id));
      assert.equal(JSON.parse(fs.readFileSync(notesFile, 'utf8')).length, 1);
      assert.equal((await request(server, '/api/notes', 'POST', { ...note, qq: '' })).status, 201);
    });
    await t.test('待审核记录不能被其他访客读取；后台需要鉴权', async () => {
      assert.deepEqual((await request(server, '/api/notes')).body, []);
      assert.deepEqual((await request(server, '/api/draw/pool')).body, []);
      assert.equal((await request(server, '/api/admin/notes')).status, 401);
      token = (await request(server, '/api/login', 'POST', { password })).body.token;
      assert.ok(token);
    });
    await t.test('审核后其他客户端可读取；墙不含 QQ，拆信含选填 QQ', async () => {
      assert.equal((await request(server, `/api/admin/notes/${id}/status`, 'POST', { status: 'approved' }, token)).status, 200);
      const wall = (await request(server, '/api/notes')).body;
      assert.equal(wall[0].id, id);
      assert.equal('qq' in wall[0], false);
      assert.equal((await request(server, '/api/draw/pool')).body[0].qq, note.qq);
      assert.equal((await request(server, '/api/admin/export', 'GET', undefined, token)).body.length, 2);
    });
    await t.test('跨站写入和超过 32KB 的请求被拒绝', async () => {
      assert.equal((await request(server, '/api/notes', 'POST', note, undefined, { Origin: 'https://other.example' })).status, 403);
      assert.equal((await request(server, '/api/notes', 'POST', { ...note, content: '大'.repeat(20000) })).status, 413);
    });
    await t.test('磁盘不可写时返回 503，内存不会假装修改成功', async () => {
      fs.mkdirSync(notesFile + '.tmp');
      try {
        assert.equal((await request(server, `/api/admin/notes/${id}/status`, 'POST', { status: 'rejected' }, token)).status, 503);
        assert.equal((await request(server, '/api/notes')).body.length, 1);
        assert.equal((await request(server, '/api/notes', 'POST', { ...note, name: '写入失败' })).status, 503);
        assert.equal((await request(server, '/api/admin/notes', 'GET', undefined, token)).body.length, 2);
      } finally { fs.rmdirSync(notesFile + '.tmp'); }
    });
    await t.test('进程结束后重启保留提交与审核，重试仍然幂等', async () => {
      await stop(server);
      server = await start(dataDir);
      assert.equal((await request(server, '/api/notes')).body[0].id, id);
      assert.equal((await request(server, '/api/notes', 'POST', note)).body.id, id);
      token = (await request(server, '/api/login', 'POST', { password })).body.token;
    });
    await t.test('删除后可重新投递同内容；退出后的旧 token 失效', async () => {
      assert.equal((await request(server, `/api/admin/notes/${id}`, 'DELETE', undefined, token)).status, 200);
      assert.equal((await request(server, '/api/notes', 'POST', note)).status, 201);
      assert.equal((await request(server, '/api/admin/logout', 'POST', {}, token)).status, 200);
      assert.equal((await request(server, '/api/admin/notes', 'GET', undefined, token)).status, 401);
    });
    await t.test('自动备份内容完整，主文件损坏时恢复上一版', async () => {
      const run = spawnSync(process.execPath, ['backup.js', dataDir], { cwd: __dirname, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const backup = fs.readdirSync(path.join(dataDir, 'backups')).find(f => f.endsWith('.json'));
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'backups', backup))), JSON.parse(fs.readFileSync(notesFile)));
      await stop(server);
      fs.writeFileSync(notesFile, '{broken');
      server = await start(dataDir);
      assert.equal((await request(server, '/api/health')).body.count, 1);
      assert.ok(fs.readdirSync(dataDir).some(f => f.includes('.corrupt-')));
    });
    await t.test('真实 300 条长心得、300 并发读取压测，无错误和超时', async () => {
      await stop(server);
      fs.writeFileSync(notesFile, JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ ...note, id: i + 1, name: `书友${i}`, content: '读书心得'.repeat(500), status: 'approved', time: '2026/10/11 12:00:00' }))));
      server = await start(dataDir);
      const child = spawn(process.execPath, ['loadtest.js', server.base, '300', '--burst', '--quiet'], { cwd: __dirname });
      let output = '';
      child.stdout.on('data', b => { output += b; });
      child.stderr.on('data', b => { output += b; });
      const [code] = await once(child, 'exit');
      console.log(output);
      assert.equal(code, 0, output);
      const smoke = spawn(process.execPath, ['smoke-test.js', server.base], { cwd: __dirname, env: { ...process.env, ADMIN_PASSWORD: password } });
      let smokeOutput = '';
      smoke.stdout.on('data', b => { smokeOutput += b; });
      smoke.stderr.on('data', b => { smokeOutput += b; });
      const [smokeCode] = await once(smoke, 'exit');
      console.log(smokeOutput);
      assert.equal(smokeCode, 0, smokeOutput);
      const mixed = spawn(process.execPath, ['loadtest.js', server.base, '50', '--burst', '--submit', '1', '--quiet'], { cwd: __dirname });
      let mixedOutput = '';
      mixed.stdout.on('data', b => { mixedOutput += b; });
      mixed.stderr.on('data', b => { mixedOutput += b; });
      const [mixedCode] = await once(mixed, 'exit');
      console.log(mixedOutput);
      assert.equal(mixedCode, 0, mixedOutput);
      assert.equal((await request(server, '/api/health')).body.count, 350, '50 位同学全部提交成功');
    });
    await t.test('全库损坏时停止启动，生产环境拒绝默认密码', async () => {
      await stop(server);
      fs.writeFileSync(notesFile, '{broken');
      fs.writeFileSync(notesFile + '.prev', '{broken');
      const bad = spawnSync(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', timeout: 5000 });
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /所有数据文件都不可用/);
      const retry = spawnSync(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', timeout: 5000 });
      assert.notEqual(retry.status, 0, '自动重启也不得新建空库');
      assert.match(retry.stderr, /所有数据文件都不可用/);
      assert.equal(fs.existsSync(notesFile), false);
      fs.writeFileSync(notesFile, '[]');
      server = await start(dataDir);
      assert.equal((await request(server, '/api/health')).body.count, 0);
      assert.equal(fs.existsSync(path.join(dataDir, 'recovery-required')), false);
      const unsafe = spawnSync(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, NODE_ENV: 'production', ADMIN_PASSWORD: 'admin888' }, encoding: 'utf8', timeout: 5000 });
      assert.notEqual(unsafe.status, 0);
      assert.match(unsafe.stderr, /ADMIN_PASSWORD/);
    });
  } finally {
    await stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
