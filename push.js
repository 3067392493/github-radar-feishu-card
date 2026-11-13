'use strict';
/**
 * push.js —— 把 雷达草稿.json 生成飞书交互式卡片，发给指定 open_id
 *
 * 用法：
 *   node push.js --dry-run     # 只打印卡片 JSON，不发送（用来检查内容）
 *   node push.js               # 真正发送（会用 你的open_id.txt 第一行）
 *   node push.js ou_xxxxx      # 临时指定接收人
 *
 * 前提：应用需要有 im:message:send_as_bot 权限；接收人必须在应用可用范围内。
 */

const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const RADAR = path.join(__dirname, '雷达草稿.json');
const OPENID_FILE = path.join(__dirname, '你的open_id.txt');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const argOpenId = args.find((a) => /^ou_/.test(a));

function readOpenId() {
  if (argOpenId) return argOpenId.trim();
  if (!fs.existsSync(OPENID_FILE)) return '';
  const lines = fs.readFileSync(OPENID_FILE, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines[0] || '';
}

async function tenantToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!res.ok || data.code !== 0) throw new Error(`取 token 失败：${data.code} ${data.msg}`);
  return data.tenant_access_token;
}

function buildCard(radar) {
  const items = radar.items || [];
  const elements = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**统计范围**：${radar.period}\n**筛选口径**：${radar.query ? '关键词「' + radar.query + '」' : '按 Stars 降序'}，三天内新建\n**数据来源**：${radar.source}`,
      },
    },
    { tag: 'hr' },
  ];

  items.forEach((it, i) => {
    const lines = [
      `**${i + 1}. [${it.name}](${it.url})**`,
      `介绍：${it.summary}`,
      `值得关注：${it.why_watch}`,
      `指标：${it.metrics}`,
      `[打开仓库](${it.url})`,
    ];
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } });
    if (i < items.length - 1) elements.push({ tag: 'hr' });
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: radar.title || 'GitHub 三日雷达' },
    },
    elements,
  };
}

async function main() {
  if (!fs.existsSync(RADAR)) throw new Error('找不到 雷达草稿.json，先跑 node github-radar.js');
  const radar = JSON.parse(fs.readFileSync(RADAR, 'utf8'));
  const card = buildCard(radar);

  if (dryRun) {
    console.log('[试运行] 卡片条目数：' + radar.items.length);
    console.log(JSON.stringify(card, null, 2).slice(0, 2000));
    return;
  }

  const openId = readOpenId();
  if (!openId) {
    throw new Error('还没有 open_id：先在飞书给机器人发一句话，生成 你的open_id.txt，或执行 node push.js ou_xxxx');
  }

  const token = await tenantToken();
  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`发送失败：code ${data.code} ${data.msg} ${JSON.stringify(data.error || {})}`);
  console.log('[发送成功] message_id ' + (data.data && data.data.message_id));
}

main().catch((e) => {
  console.error('[失败]', e.message);
  process.exitCode = 1;
});
