#!/usr/bin/env node
/**
 * fetch_aluminum.js —— 抓取长江现货 A00 铝均价，生成 aluminum.json
 *
 * 数据源：
 *   今日价格：https://m.ccmn.cn/ （长江有色金属网，长江现货 A00 铝，公开页面）
 *   近7日历史：https://market.cnal.com/historical/search.html （世铝网 有色宝长江 A00 铝）
 *             ccmn 的历史接口需付费登录，故用 cnal 同口径序列补齐，今日值以 ccmn 为准。
 *
 * 用法：
 *   node fetch_aluminum.js
 *   node fetch_aluminum.js -o ./github-pages/aluminum.json
 *
 * 输出结构：
 *   {
 *     updated_at: "2026-11-02 10:30",
 *     date: "2026-11-02",
 *     price: 23520,          // 今日 A00 均价（元/吨，来自 ccmn）
 *     min: 23500, max: 23540,
 *     change: -260,          // 较上一交易日
 *     source: "长江有色网",
 *     trend: [{date:'10-27', price:23900}, ...]  // 近7个交易日，旧→新
 *   }
 */
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function request(urlStr, options) {
  const opts = options || {};
  return new Promise(function (resolve, reject) {
    const u = new URL(urlStr);
    const mod = u.protocol === 'http:' ? http : https;
    const body = opts.body ? Buffer.from(opts.body) : null;
    const headers = Object.assign(
      {
        'User-Agent': UA,
        Accept: 'text/html,application/json,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      },
      opts.headers || {}
    );
    if (body) headers['Content-Length'] = body.length;

    const req = mod.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: headers,
        timeout: 20000
      },
      function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, u).toString();
          res.resume();
          resolve(request(next, opts));
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', function (c) {
          data += c;
        });
        res.on('end', function () {
          resolve({ status: res.statusCode, text: data });
        });
      }
    );
    req.on('timeout', function () {
      req.destroy(new Error('请求超时'));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 今天（北京时间 YYYY-MM-DD） */
function todayCN() {
  const now = new Date();
  const cn = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
  const p = function (n) {
    return String(n).padStart(2, '0');
  };
  return cn.getFullYear() + '-' + p(cn.getMonth() + 1) + '-' + p(cn.getDate());
}

function shiftDate(ymd, days) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function num(s) {
  const n = parseFloat(String(s || '').replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

/** 从 ccmn 移动端首页取长江现货 A00 铝（链接含 /chart/cjxh/） */
async function fetchCcmn() {
  const res = await request('https://m.ccmn.cn/', {
    headers: { Referer: 'https://m.ccmn.cn/' }
  });
  if (res.status !== 200) throw new Error('ccmn HTTP ' + res.status);
  const html = res.text;

  // 定位「长江现货」A00：锚点 href 含 /chart/cjxh/
  const blocks = html.split('<a ').filter(function (s) {
    return s.indexOf('/chart/cjxh/') > -1 && s.indexOf('A00') > -1;
  });
  for (const blk of blocks) {
    const ps = [];
    const re = /<p[^>]*>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = re.exec(blk))) ps.push(m[1].replace(/<[^>]+>/g, '').trim());
    const nameIdx = ps.findIndex(function (t) {
      return t.indexOf('A00') === 0;
    });
    if (nameIdx < 0) continue;
    const range = ps[nameIdx + 1] || '';
    const avg = num(ps[nameIdx + 2]);
    const chg = num(ps[nameIdx + 3].replace('+', ''));
    const nums = range.split(/[—\-－~至]/).map(num).filter(function (v) {
      return v !== null;
    });
    if (avg !== null) {
      return {
        price: avg,
        min: nums.length ? Math.min.apply(null, nums) : null,
        max: nums.length ? Math.max.apply(null, nums) : null,
        change: chg,
        name: ps[nameIdx]
      };
    }
  }
  throw new Error('未在 ccmn 页面中解析到长江现货 A00 铝');
}

/** 从 cnal 取近 n 天逐日均价（selectid=3 为铝） */
async function fetchCnalTrend(days) {
  const end = todayCN();
  const start = shiftDate(end, -(days * 2 + 3)); // 多取几天，覆盖周末/假期
  const body =
    'starttime=' + encodeURIComponent(start) +
    '&endtime=' + encodeURIComponent(end) +
    '&selectid=3';
  const res = await request('https://market.cnal.com/historical/search.html', {
    method: 'POST',
    body: body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://market.cnal.com/historical/',
      Origin: 'https://market.cnal.com'
    }
  });
  if (res.status !== 200) throw new Error('cnal HTTP ' + res.status);

  const rows = [];
  const trRe = /<tr>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>/g;
  let m;
  while ((m = trRe.exec(res.text))) {
    const name = m[1].trim();
    const avg = num(m[3]);
    const dateRaw = m[5].trim(); // 26-11-02
    if (name.indexOf('区间均价') > -1) continue;
    const dm = dateRaw.match(/^(\d{2})-(\d{2})-(\d{2})$/);
    if (!dm || avg === null) continue;
    rows.push({ date: '20' + dm[1] + '-' + dm[2] + '-' + dm[3], price: avg });
  }
  rows.sort(function (a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });
  return rows.slice(-days);
}

async function build() {
  const warnings = [];
  let today = null;

  try {
    today = await fetchCcmn();
  } catch (e) {
    warnings.push('ccmn 抓取失败：' + e.message);
  }

  let trend = [];
  try {
    trend = await fetchCnalTrend(7);
  } catch (e) {
    warnings.push('cnal 历史抓取失败：' + e.message);
  }

  if (!today) {
    // 兜底：用 cnal 最新一条
    if (trend.length) {
      const last = trend[trend.length - 1];
      const prev = trend.length > 1 ? trend[trend.length - 2].price : null;
      today = {
        price: last.price,
        min: null,
        max: null,
        change: prev === null ? null : last.price - prev,
        name: 'A00铝'
      };
      warnings.push('今日价格回退为 cnal 数据');
    } else {
      throw new Error('两个数据源均不可用');
    }
  }

  const date = todayCN();

  // 趋势：cnal 历史 + 今日 ccmn 覆盖，保留最近 7 个交易日
  const map = {};
  trend.forEach(function (r) {
    map[r.date] = r.price;
  });
  map[date] = today.price;

  const points = Object.keys(map)
    .sort()
    .slice(-7)
    .map(function (d) {
      return { date: d, label: d.slice(5), price: map[d] };
    });

  const now = new Date();
  const cn = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
  const p = function (n) {
    return String(n).padStart(2, '0');
  };

  return {
    payload: {
      updated_at:
        cn.getFullYear() + '-' + p(cn.getMonth() + 1) + '-' + p(cn.getDate()) +
        ' ' + p(cn.getHours()) + ':' + p(cn.getMinutes()),
      date: date,
      price: today.price,
      min: today.min,
      max: today.max,
      change: today.change,
      source: '长江有色网',
      history_source: '世铝网·有色宝长江',
      trend: points
    },
    warnings: warnings
  };
}

/** 合并历史到输出文件：保留最近 40 天，便于后续扩展长周期图 */
function mergeHistory(payload, outFile) {
  let old = null;
  try {
    old = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch (e) {
    old = null;
  }
  if (old && Array.isArray(old.history)) {
    const map = {};
    old.history.forEach(function (r) {
      if (r && r.date && typeof r.price === 'number') map[r.date] = r.price;
    });
    (payload.trend || []).forEach(function (r) {
      map[r.date] = r.price;
    });
    payload.history = Object.keys(map)
      .sort()
      .slice(-40)
      .map(function (d) {
        return { date: d, price: map[d] };
      });
  } else {
    payload.history = (payload.trend || []).map(function (r) {
      return { date: r.date, price: r.price };
    });
  }
  return payload;
}

async function main() {
  const args = process.argv.slice(2);
  let out = path.join(__dirname, 'github-pages', 'aluminum.json');
  let jsOut = path.join(__dirname, '..', 'quote-miniapp', 'miniprogram', 'data', 'aluminum.js');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '--output') out = args[++i];
    else if (args[i] === '-j' || args[i] === '--js') jsOut = args[++i];
    else if (args[i] === '--no-js') jsOut = null;
  }

  const r = await build();
  const payload = mergeHistory(r.payload, out);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');

  // 小程序内置快照（离线兜底）
  if (jsOut) {
    fs.mkdirSync(path.dirname(jsOut), { recursive: true });
    fs.writeFileSync(
      jsOut,
      '/* 自动生成，请勿手改：由 tools/fetch_aluminum.js 抓取长江现货 A00 铝均价 */\n' +
        'module.exports = ' + JSON.stringify(payload, null, 2) + ';\n',
      'utf8'
    );
  }

  console.log('✅ 已生成 ' + out + (jsOut ? ' 与 ' + jsOut : ''));
  console.log('   日期 ' + payload.date + ' | A00铝均价 ' + payload.price + ' 元/吨' +
    (payload.change === null ? '' : ' | 涨跌 ' + payload.change));
  console.log('   近7日：' + payload.trend.map(function (t) {
    return t.label + ' ' + t.price;
  }).join(' → '));
  if (r.warnings.length) {
    console.warn('⚠️  ' + r.warnings.join('; '));
  }
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('❌ 失败：' + e.message);
    process.exit(1);
  });
}

module.exports = { build: build, fetchCcmn: fetchCcmn, fetchCnalTrend: fetchCnalTrend };
