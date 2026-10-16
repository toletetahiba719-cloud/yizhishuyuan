'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 运行实际内联脚本，模拟浏览器 DOM 和计时器，覆盖曾导致页面挂死的交互。
function browser(overrides = {}) {
  const elements = new Map();
  const timers = [];
  function element() {
    const classes = new Set();
    return {
      value: '', textContent: '', style: {}, dataset: {}, children: [], disabled: false,
      classList: {
        add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); },
        toggle(c, force) { const add = force === undefined ? !classes.has(c) : force; if (add) classes.add(c); else classes.delete(c); return add; }
      },
      get firstElementChild() { return this.children[0] || null; },
      get lastElementChild() { return this.children[this.children.length - 1] || null; },
      appendChild(child) { child.parentElement = this; this.children.push(child); },
      remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); },
      addEventListener() {}, setAttribute() {}, removeAttribute() {}, scrollIntoView() {},
      querySelectorAll() { return []; }, select() {}
    };
  }
  const document = {
    hidden: false,
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    querySelectorAll() { return []; }, createElement: element, addEventListener() {}, body: element()
  };
  const storage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  const context = vm.createContext({
    document, location: { protocol: 'file:', hash: '' }, localStorage: storage, sessionStorage: storage,
    window: { scrollTo() {}, addEventListener() {} }, navigator: {}, console,
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval() {},
    requestAnimationFrame() {}, confirm() { return true; }, Blob, URL, AbortController, ...overrides
  });
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(code, context, { timeout: 1000 });
  return { context, timers, document };
}
test('连续四条提示不会让页面死循环，提示最多三条', () => {
  const { context, document } = browser();
  vm.runInContext("toast('姓名错误');toast('书名错误');toast('网络错误');toast('密码错误')", context, { timeout: 1000 });
  assert.equal(document.getElementById('toastStack').children.length, 3);
  assert.equal(document.getElementById('toastStack').children[0].textContent, '书名错误');
});
test('拆信动画结束前切页，不显示旧结果也不访问空信件', () => {
  const { context, timers, document } = browser();
  vm.runInContext("currentPage='draw';currentDraw={id:1,book:'测试',content:'心得',name:'书友'};openEnvelope();goTo('home');currentDraw=null", context);
  for (const timer of timers.filter(t => t.ms === 700)) assert.doesNotThrow(timer.fn);
  assert.notEqual(document.getElementById('envelopeResult').style.display, 'block');
});

test('会话过期后清除后台表格、统计和搜索内容', () => {
  const { context, document } = browser();
  document.getElementById('adminTableBody').innerHTML = '<tr>待审核内容与联系方式</tr>';
  document.getElementById('adminSearch').value = '某位书友';
  document.getElementById('stat-total').textContent = '12';
  vm.runInContext("adminToken='expired';isLoggedIn=true;adminCache=[{id:1}];forceLogout()", context);
  assert.equal(document.getElementById('adminTableBody').innerHTML, '');
  assert.equal(document.getElementById('adminSearch').value, '');
  assert.equal(document.getElementById('stat-total').textContent, '0');
  assert.equal(vm.runInContext('adminCache === null && adminToken === null && !isLoggedIn', context), true);
});

test('旧会话的迟到 401 不会退出新登录的会话', async () => {
  const { context } = browser({
    location: { protocol: 'https:', hash: '' },
    fetch: async () => ({ status: 401, ok: false, json: async () => ({ error: '登录已过期' }) })
  });
  vm.runInContext("adminToken='new-session';isLoggedIn=true", context);
  await assert.rejects(vm.runInContext("apiFetch('/api/admin/notes',{headers:{Authorization:'Bearer old-session'}})", context));
  assert.equal(vm.runInContext("isLoggedIn && adminToken === 'new-session'", context), true);
  await assert.rejects(vm.runInContext("apiFetch('/api/admin/notes',{headers:{Authorization:'Bearer new-session'}})", context));
  assert.equal(vm.runInContext('isLoggedIn', context), false);
});
