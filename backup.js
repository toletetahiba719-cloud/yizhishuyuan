#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const dataDir = path.resolve(process.argv[2] || path.join(__dirname, 'data'));
const backupDir = path.join(dataDir, 'backups');
const raw = fs.readFileSync(path.join(dataDir, 'notes.json'));
if (!Array.isArray(JSON.parse(raw.toString('utf8')))) throw new Error('主数据格式错误，未创建备份');
fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const target = path.join(backupDir, `notes-${date}.json`);
const temp = target + '.tmp';
const fd = fs.openSync(temp, 'w', 0o600);
try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
fs.renameSync(temp, target);
for (const file of fs.readdirSync(backupDir)) {
  if (!/^notes-\d{4}-\d{2}-\d{2}\.json$/.test(file)) continue;
  const absolute = path.join(backupDir, file);
  if (Date.now() - fs.statSync(absolute).mtimeMs > 14 * 86400000) fs.unlinkSync(absolute);
}
console.log(`备份成功：${target}（${raw.length} 字节）`);
