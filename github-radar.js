'use strict';
/**
 * github-radar.js —— GitHub 三日雷达（数据来自 GitHub 官方公开 API）
 *
 * 用法：
 *   node github-radar.js                # 默认抓 AI Agent 相关的新项目
 *   node github-radar.js langchain      # 自定义关键词
 *
 * 说明：
 *   - 只查 created:>= 三天前 的仓库，按 stars 排序，取前 10 个
 *   - 每个仓库的"一句话介绍"和"关注理由"由本地 qwen2 生成，中文
 *   - 输出 rada草稿.json 和 雷达草稿.md
 *   - 未登录调用 GitHub 接口有速率限制（每分钟 10 次搜索），一次运行只发 1 次请求
 */

const fs = require('fs');
const path = require('path');

// 默认按 topics 精确筛，比裸关键词干净得多；也可以用参数覆盖成任意关键词
const DEFAULT_QUERIES = ['topic:ai-agent', 'topic:mcp-server', 'topic:agent-skills', 'topic:ai-agents', 'topic:llm'];
const ARG = process.argv[2];
const QUERIES = ARG ? [ARG] : DEFAULT_QUERIES;
const PER_PAGE = 8;
const MIN_STARS = 50; // 低于这个数的多半是占位/垃圾仓，直接丢掉
const MIN_FORKS = 5;  // 刷星的仓库通常没人真 fork，用这个当第二道筛子

// 三天前（按本地时区算，转成 UTC 字符串）
function threeDaysAgoUTC() {
  const now = new Date();
  const d = new Date(now.getTime() - 3 * 24 * 3600 * 1000);
  const iso = d.toISOString(); // 2026-11-10T14:00:00.000Z
  return iso.slice(0, 10);     // 2026-11-10
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function searchRepos(oneQuery, since) {
  // 关键词 + 三天内新建 + 星标门槛（写进查询里，才能在源头过滤掉刷星空壳仓），按 star 降序
  const q = `${oneQuery} created:>=${since} stars:>=${MIN_STARS}`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${PER_PAGE}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'github-radar-local',
      'Accept': 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(30000),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub 接口返回 ${res.status}：${raw.slice(0, 300)}`);
  }
  const data = JSON.parse(raw);
  return {
    total: data.total_count,
    items: (data.items || [])
      .filter((it) => !it.archived && it.stargazers_count >= MIN_STARS && it.forks_count >= MIN_FORKS)
      .map((it) => ({
        name: it.full_name,
        url: it.html_url,
        desc: it.description || '',
        language: it.language || '未标注',
        stars: it.stargazers_count,
        forks: it.forks_count,
        created_at: it.created_at,
        topics: it.topics || [],
        matched: oneQuery,
      })),
  };
}

async function summarize(repo, cfg) {
  const ollama = String(cfg.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = cfg.model || 'qwen2:latest';
  const prompt = [
    '下面是一个 GitHub 仓库的信息。请用中文写两句，严格按格式输出，不要多余内容：',
    '介绍：<一句话说它是干什么的，不超过 30 字>',
    '关注：<对普通用户值得关注的理由，不超过 30 字>',
    '',
    `仓库：${repo.name}`,
    `语言：${repo.language}`,
    `描述：${repo.desc.slice(0, 400)}`,
    `Topics：${repo.topics.slice(0, 8).join(', ')}`,
  ].join('\n');

  const res = await fetch(ollama + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 200,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`本地模型返回 ${res.status}`);
  const data = await res.json();
  const text = ((data.choices && data.choices[0] && data.choices[0].message.content) || '').trim();

  const intro = (text.match(/介绍[：:]\s*(.+)/) || [])[1] || '';
  const watch = (text.match(/关注[：:]\s*(.+)/) || [])[1] || '';
  return {
    intro: intro.trim() || '（模型未给出介绍）',
    watch: watch.trim() || '（模型未给出理由）',
  };
}

async function main() {
  const cfg = loadConfig();
  const since = threeDaysAgoUTC();
  console.log(`[1/3] 查询 GitHub：${QUERIES.join(' / ')}，新建时间 >= ${since}，Stars >= ${MIN_STARS}`);

  const pool = [];
  const seen = new Set();
  let totalHit = 0;
  for (const q of QUERIES) {
    try {
      const r = await searchRepos(q, since);
      totalHit += r.total;
      console.log(`      「${q}」命中 ${r.total} 个，可用 ${r.items.length} 个`);
      for (const it of r.items) {
        if (seen.has(it.name)) continue;
        seen.add(it.name);
        pool.push(it);
      }
    } catch (e) {
      console.log(`      「${q}」失败：${e.message}`);
    }
    await new Promise((res) => setTimeout(res, 3000)); // 搜索接口限流 10 次/分钟，缓一缓
  }

  pool.sort((a, b) => b.stars - a.stars);
  const items = pool.slice(0, 10);
  console.log(`      合并去重后共 ${pool.length} 个，取 Stars 最高的 ${items.length} 个`);
  if (!items.length) {
    console.log('      没有符合条件的新仓库，换个关键词试试');
    return;
  }

  console.log('[2/3] 让本地模型写中文介绍…');
  const enriched = [];
  for (let i = 0; i < items.length; i++) {
    const repo = items[i];
    let s = { intro: '', watch: '' };
    try {
      s = await summarize(repo, cfg);
    } catch (e) {
      s = { intro: `（摘要失败：${e.message}）`, watch: '待进一步评估' };
    }
    enriched.push({ ...repo, ...s });
    console.log(`      ${i + 1}/${items.length} ${repo.name}`);
  }

  const now = new Date();
  const stamp = now.toLocaleString('zh-CN', { hour12: false });

  const payload = {
    title: 'GitHub 三日雷达',
    period: `${since} 至 ${stamp}（Asia/Shanghai）`,
    source: `GitHub 官方 API /search/repositories，查询时间 ${stamp}`,
    query: QUERIES.join(' / '),
    items: enriched.map((r) => ({
      name: r.name,
      url: r.url,
      summary: r.intro,
      why_watch: r.watch,
      metrics: `Stars ${r.stars} / Forks ${r.forks}（${stamp} 查询）`,
      language: r.language,
      created_at: r.created_at,
    })),
    actions: enriched.map((r) => ({ label: '打开仓库', url: r.url })),
  };

  fs.writeFileSync(path.join(__dirname, '雷达草稿.json'), JSON.stringify(payload, null, 2), 'utf8');

  const md = [
    '# GitHub 三日雷达',
    `统计范围：${payload.period}`,
    `筛选口径：${QUERIES.join(' / ')}，新建时间 >= ${since}，Stars >= ${MIN_STARS}，按 Stars 降序`,
    `数据来源：${payload.source}`,
    '',
    ...enriched.map((r, i) => [
      `## ${i + 1}. ${r.name}`,
      `- 链接：${r.url}`,
      `- 一句话介绍：${r.intro}`,
      `- 值得关注：${r.watch}`,
      `- 指标：Stars ${r.stars} / Forks ${r.forks}（${stamp} 查询）`,
      `- 语言：${r.language}　创建于：${r.created_at}`,
      '',
    ].join('\n')),
  ].join('\n');

  fs.writeFileSync(path.join(__dirname, '雷达草稿.md'), md, 'utf8');
  console.log('[3/3] 已写出 雷达草稿.json 和 雷达草稿.md');
}

main().catch((e) => {
  console.error('[失败]', e.message);
  process.exitCode = 1;
});
