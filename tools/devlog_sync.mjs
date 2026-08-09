#!/usr/bin/env node
// git のコミットから docs/devlog/LOG.md へ機械的に追記する。
//
//   node tools/devlog_sync.mjs          # 未記録のコミットを追記
//   node tools/devlog_sync.mjs --dry    # 追記内容を表示するだけ
//
// LOG.md に既に載っているコミットハッシュは飛ばすので、何度実行しても重複しない。
// 指示の原文や実測値は、必要なら追記後に手で足す(機械では取れないため)。
import { execSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(ROOT, 'docs', 'devlog', 'LOG.md');
const DRY = process.argv.includes('--dry');

const git = (cmd) => execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf8' });

const logText = readFileSync(LOG, 'utf8');

// 区切り文字は本文に現れないものを選ぶ
const SEP = '';
const REC = '';
const raw = git(`log --reverse --pretty=format:"%h${SEP}%ad${SEP}%s${SEP}%b${REC}" --date=format:"%m-%d %H:%M"`);

// 古い順に並べ、LOG.md に載っている最後のコミットを見つけ、それ以降だけを追記する。
// (単純な「未記載なら追記」だと、手書きした区間より前のコミットが末尾に付いて時系列が壊れる)
const all = [];
for (const rec of raw.split(REC)) {
  const line = rec.replace(/^\n/, '');
  if (!line.trim()) continue;
  const [hash, date, subject, body] = line.split(SEP);
  all.push({ hash, date, subject, body: (body || '').trim() });
}

let lastRecorded = -1;
for (let i = 0; i < all.length; i++) {
  if (logText.includes(all[i].hash)) lastRecorded = i;
}
const entries = all.slice(lastRecorded + 1);

if (entries.length === 0) {
  console.log('追記するコミットはありません。');
  process.exit(0);
}

// 本文から Co-Authored-By / Claude-Session の行は落とす(毎回同じで情報量がない)
const cleanBody = (body) =>
  body
    .split('\n')
    .filter((l) => !/^(Co-Authored-By|Claude-Session):/.test(l))
    .join('\n')
    .trim();

let out = '';
for (const e of entries) {
  out += `\n## ${e.date} — ${e.subject}\n\n`;
  const b = cleanBody(e.body);
  if (b) out += `${b}\n\n`;
  out += `**コミット**: \`${e.hash}\`\n`;
}

if (DRY) {
  process.stdout.write(out);
} else {
  appendFileSync(LOG, out);
  console.log(`${entries.length}件を LOG.md へ追記しました。`);
}
