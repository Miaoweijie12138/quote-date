#!/usr/bin/env node
/**
 * fetch_aluminum.js —— 抓取铝价，生成 aluminum.json（首页板块 + 趋势图页共用）
 *
 * 数据源：
 *   长江现货 A00（图上标注 SMM 铝价）：
 *     今日：https://market.cnal.com/changjiang/        页面内嵌 JSON-LD（price/区间/涨跌/日期）
 *           备用：https://m.ccmn.cn/ （长江有色金属网移动端首页）
 *     历史：https://market.cnal.com/historical/search.html  POST selectid=3（铝）
 *
 *   LME 铝 3M（美元/吨）：
 *     尝试1：https://www.lme.com/Metals/Non-ferrous/LME-Aluminium
 *            ⚠️ 官网挂 Akamai 反爬，服务器/CI 直连常年返回 403，仅作首选尝试
 *     主源：新浪财经 LME 铝（AHD）日K + hf_AHD 实时（node 直连稳定）
 *            https://stock2.finance.sina.com.cn/futures/api/jsonp.php/.../GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=AHD
 *     兜底：东方财富 LME 综合铝03（109.LALT，与 LME 3M 同标的）
 *            日K：https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=109.LALT&klt=101
 *            实时：https://push2.eastmoney.com/api/qt/stock/get?secid=109.LALT
 *            ⚠️ 东财对连续请求限流明显（短时间内多次连击会被断连），只适合每天一次的低频抓取
 *
 * 用法：
 *   node fetch_aluminum.js
 *   node fetch_aluminum.js -o ./github-pages/aluminum.json
 *   node fetch_aluminum.js -o out.json --no-js
 *
 * 输出结构（节选）：
 *   {
 *     updated_at, date, price, min, max, change, source,     // 首页板块沿用的旧字段
 *     trend:  [近7个交易日],
 *     history:[近40个交易日],
 *     smm: { name, unit:'元/吨', currency:'CNY', latest, change, change_pct, source, series:[最多150条] },
 *     lme: { name, unit:'美元/吨', currency:'USD', latest, change, change_pct, source, source_note, series:[最多150条] }
 *   }
 */
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

/** 序列保留长度（支撑 7/30/90 天三档切换，还能留些余量） */
const SERIES_DAYS = 150;

const CNAL_CHANGJIANG = 'https://market.cnal.com/changjiang/';
const CNAL_HISTORY = 'https://market.cnal.com/historical/search.html';
const LME_OFFICIAL = 'https://www.lme.com/Metals/Non-ferrous/LME-Aluminium';
const SINA_KLINE =
  'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_AHD=' +
  '/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=AHD';
const SINA_REALTIME = 'https://hq.sinajs.cn/list=hf_AHD';
const EM_KLINE =
  'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=109.LALT' +
  '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1' +
  '&end=20500101&lmt=';
const EM_QUOTE =
  'https://push2.eastmoney.com/api/qt/stock/get?secid=109.LALT' +
  '&invt=2&fltt=2&fields=f43,f57,f58,f60,f86,f169,f170';

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
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
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
        const chunks = [];
        res.on('data', function (c) {
          chunks.push(c);
        });
        res.on('end', function () {
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') });
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
  return cnDate(new Date()).ymd;
}

function cnDate(d) {
  const cn = new Date(d.getTime() + (8 * 60 + d.getTimezoneOffset()) * 60000);
  const p = function (n) {
    return String(n).padStart(2, '0');
  };
  return {
    ymd: cn.getFullYear() + '-' + p(cn.getMonth() + 1) + '-' + p(cn.getDate()),
    hm: p(cn.getHours()) + ':' + p(cn.getMinutes()),
    full:
      cn.getFullYear() + '-' + p(cn.getMonth() + 1) + '-' + p(cn.getDate()) +
      ' ' + p(cn.getHours()) + ':' + p(cn.getMinutes())
  };
}

function shiftDate(ymd, days) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function num(s) {
  const n = parseFloat(String(s == null ? '' : s).replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

function round(n, p) {
  if (n === null || !isFinite(n)) return null;
  const f = Math.pow(10, p == null ? 2 : p);
  return Math.round(n * f) / f;
}

/* ============================ 长江现货 A00 ============================ */

/**
 * 长江现货 A00 最新价：解析行情页内嵌的 schema.org JSON-LD。
 * 相比抓 HTML 表格更稳（页面改版只要还留结构化数据就不受影响）。
 */
async function fetchCnalLatest() {
  const res = await request(CNAL_CHANGJIANG, {
    headers: { Referer: 'https://market.cnal.com/' }
  });
  if (res.status !== 200) throw new Error('cnal 行情页 HTTP ' + res.status);

  const blocks = res.text.match(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/g) || [];
  for (const blk of blocks) {
    const raw = blk.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    let p = null;
    try {
      p = JSON.parse(raw);
    } catch (e) {
      continue;
    }
    const offers = p && p.offers;
    if (!offers || offers.price == null) continue;
    const price = num(offers.price);
    if (price === null) continue;

    const props = {};
    (p.additionalProperty || []).forEach(function (it) {
      if (it && it.name) props[it.name] = it.value;
    });
    const range = String(props['价格区间'] || '');
    const nums = range
      .split(/[~～—\-－至]/)
      .map(num)
      .filter(function (v) {
        return v !== null;
      });

    return {
      price: price,
      min: nums.length ? Math.min.apply(null, nums) : null,
      max: nums.length ? Math.max.apply(null, nums) : null,
      change: num(String(props['涨跌'] == null ? '' : props['涨跌']).replace('+', '')),
      date: String(props['日期'] || '').slice(0, 10) || todayCN(),
      name: p.name || '长江现货 A00铝',
      source: '有色宝长江'
    };
  }
  throw new Error('未在 cnal 行情页解析到 A00 铝 JSON-LD');
}

/** 备用：ccmn 移动端首页（链接含 /chart/cjxh/） */
async function fetchCcmn() {
  const res = await request('https://m.ccmn.cn/', {
    headers: { Referer: 'https://m.ccmn.cn/' }
  });
  if (res.status !== 200) throw new Error('ccmn HTTP ' + res.status);
  const html = res.text;

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
    const chg = num(String(ps[nameIdx + 3] || '').replace('+', ''));
    const nums = range
      .split(/[—\-－~至]/)
      .map(num)
      .filter(function (v) {
        return v !== null;
      });
    if (avg !== null) {
      return {
        price: avg,
        min: nums.length ? Math.min.apply(null, nums) : null,
        max: nums.length ? Math.max.apply(null, nums) : null,
        change: chg,
        date: todayCN(),
        name: ps[nameIdx],
        source: '长江有色网'
      };
    }
  }
  throw new Error('未在 ccmn 页面中解析到长江现货 A00 铝');
}

/** 长江现货 A00 逐日均价（selectid=3 为铝） */
async function fetchCnalTrend(days) {
  const n = days || SERIES_DAYS;
  const end = todayCN();
  const start = shiftDate(end, -(n * 2 + 10)); // 多取几天，覆盖周末/假期
  const body =
    'starttime=' + encodeURIComponent(start) +
    '&endtime=' + encodeURIComponent(end) +
    '&selectid=3';
  const res = await request(CNAL_HISTORY, {
    method: 'POST',
    body: body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://market.cnal.com/historical/',
      Origin: 'https://market.cnal.com'
    }
  });
  if (res.status !== 200) throw new Error('cnal 历史 HTTP ' + res.status);

  const rows = [];
  const trRe =
    /<tr>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>/g;
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
  return rows.slice(-n);
}

/* ================================ LME ================================ */

/** LME 官网（大概率 403，仅作首选尝试） */
async function fetchLmeOfficial() {
  const res = await request(LME_OFFICIAL, {
    headers: {
      Referer: 'https://www.lme.com/',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1'
    }
  });
  if (res.status !== 200) throw new Error('LME 官网 HTTP ' + res.status);
  const m =
    res.text.match(/"cashOffer"\s*:\s*"?([\d.]+)/) ||
    res.text.match(/"lmeOfficialPrice"\s*:\s*"?([\d.]+)/);
  if (!m) throw new Error('LME 官网页面未内嵌价格数据');
  return { price: num(m[1]), source: 'LME 官网' };
}

/**
 * 东方财富：LME 综合铝03（109.LALT）日K收盘价，返回 [{date, price}] 旧→新
 * klines 行格式 "date,open,close,high,low,volume"
 */
async function fetchLmeEmKline(days) {
  const n = (days || SERIES_DAYS) + 20; // 多留余量覆盖节假日
  const res = await request(EM_KLINE + n, {
    headers: { Referer: 'https://quote.eastmoney.com/' }
  });
  if (res.status !== 200) throw new Error('东财日K HTTP ' + res.status);
  let data = null;
  try {
    data = JSON.parse(res.text).data;
  } catch (e) {
    throw new Error('东财日K JSON 解析失败');
  }
  if (!data || !Array.isArray(data.klines) || !data.klines.length) {
    throw new Error('东财日K无数据');
  }
  const rows = [];
  data.klines.forEach(function (line) {
    const f = String(line).split(',');
    const d = String(f[0] || '').slice(0, 10);
    const v = num(f[2]); // close
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || v === null) return;
    rows.push({ date: d, price: v });
  });
  if (!rows.length) throw new Error('东财日K解析后为空');
  rows.sort(function (a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });
  return rows.slice(-days || -SERIES_DAYS);
}

/** 东方财富：LME 综合铝03 实时报价，失败返回 null */
async function fetchLmeEmRealtime() {
  try {
    const res = await request(EM_QUOTE, {
      headers: { Referer: 'https://quote.eastmoney.com/' }
    });
    if (res.status !== 200) return null;
    const data = JSON.parse(res.text).data;
    const price = data && num(data.f43);
    if (price === null || price <= 0) return null;
    return {
      price: price,
      prev: num(data.f60),
      change: num(data.f169),
      change_pct: num(data.f170),
      time: data.f86 ? new Date(data.f86 * 1000).toISOString() : '',
      name: 'LME 铝 3M'
    };
  } catch (e) {
    return null;
  }
}

/** 新浪外盘：LME 铝（AHD）实时报价，失败返回 null */
async function fetchLmeRealtime() {
  try {
    const res = await request(SINA_REALTIME, {
      headers: { Referer: 'https://finance.sina.com.cn' }
    });
    if (res.status !== 200) return null;
    const m = res.text.match(/="([^"]*)"/);
    if (!m) return null;
    const f = m[1].split(',');
    const price = num(f[0]);
    if (price === null || price <= 0) return null;
    return {
      price: price,
      high: num(f[4]),
      low: num(f[5]),
      time: String(f[6] || '').trim(),
      prevSettle: num(f[8]),
      date: String(f[12] || '').trim(),
      name: 'LME 铝 3M'
    };
  } catch (e) {
    return null;
  }
}

/** 新浪外盘：LME 铝日K（结算/收盘价），返回 [{date, price}] 旧→新 */
async function fetchLmeSinaKline(days) {
  const n = days || SERIES_DAYS;
  const res = await request(SINA_KLINE, {
    headers: { Referer: 'https://finance.sina.com.cn' }
  });
  if (res.status !== 200) throw new Error('新浪日K HTTP ' + res.status);
  const i = res.text.indexOf('(');
  const j = res.text.lastIndexOf(')');
  if (i < 0 || j <= i) throw new Error('新浪日K返回格式异常');
  let arr = null;
  try {
    arr = JSON.parse(res.text.slice(i + 1, j));
  } catch (e) {
    throw new Error('新浪日K JSON 解析失败');
  }
  const rows = [];
  (arr || []).forEach(function (r) {
    const d = String(r.date || '').slice(0, 10);
    const v = num(r.close);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || v === null) return;
    rows.push({ date: d, price: v });
  });
  rows.sort(function (a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });
  return rows.slice(-n);
}

/**
 * LME 铝：官网仍先试一次 → 主源东方财富（109.LALT）→ 回退新浪。
 * 返回 { series, latest, change, change_pct, source, note }
 */
async function fetchLme(days) {
  const n = days || SERIES_DAYS;

  // 官网能拿到就用官网现价；拿不到（403）就用东财/新浪实时价
  let official = null;
  try {
    official = await fetchLmeOfficial();
  } catch (e) {
    official = null;
  }

  // 日K序列：新浪主源（node 直连稳定）；东财做兜底（限流严格，适合每天一次的低频调用）
  let series = null;
  let klineSource = '';
  try {
    series = await fetchLmeSinaKline(n);
    klineSource = '新浪财经';
  } catch (e) {
    try {
      series = await fetchLmeEmKline(n);
      klineSource = '东方财富 LME 综合铝03';
    } catch (e2) {
      throw new Error('新浪与东财日K均失败：' + e.message + ' / ' + e2.message);
    }
  }
  if (!series.length) throw new Error('LME 序列为空');

  // 实时：新浪优先，东财兜底
  const sinaRt = await fetchLmeRealtime();
  const emRt = sinaRt ? null : await fetchLmeEmRealtime();
  const last = series[series.length - 1];
  const latest = (official && official.price) || (emRt && emRt.price) || (sinaRt && sinaRt.price) || last.price;

  // 涨跌基准：上一交易日收盘（实时接口自带涨跌时以接口为准）
  const prev = series.length > 1 ? series[series.length - 2].price : null;
  let change = prev === null ? null : round(latest - prev, 1);
  let pct = prev ? round(((latest - prev) / prev) * 100, 2) : null;
  if (!official && emRt && emRt.price === latest && emRt.change != null) {
    change = emRt.change;
    pct = emRt.change_pct;
  }

  const srcNote = official
    ? 'LME 官网（历史序列取自' + klineSource + '）'
    : klineSource + '（LME 3M 铝同步行情）';
  const note = official
    ? '现价取自 LME 官网，历史曲线取 LME 3M 铝日收盘价'
    : 'LME 官网设有反爬（直连返回 403），曲线取 LME 3M 铝期货日收盘价（' + klineSource + '同步）';

  return {
    series: series,
    latest: round(latest, 1),
    high: sinaRt ? sinaRt.high : null,
    low: sinaRt ? sinaRt.low : null,
    prev: prev,
    change: change,
    change_pct: pct,
    source: srcNote,
    note: note,
    last_date: last.date
  };
}

/* ============================== 组装输出 ============================== */

function mergeSeries(newList, oldList, keep) {
  const m = {};
  (oldList || []).forEach(function (r) {
    if (r && r.date && typeof r.price === 'number') m[r.date] = r.price;
  });
  (newList || []).forEach(function (r) {
    if (r && r.date && typeof r.price === 'number') m[r.date] = r.price;
  });
  return Object.keys(m)
    .sort()
    .slice(-keep)
    .map(function (d) {
      return { date: d, price: m[d] };
    });
}

async function build(opt) {
  const options = opt || {};
  const warnings = [];

  // 1) 长江现货 A00 最新
  let latest = null;
  try {
    latest = await fetchCnalLatest();
  } catch (e) {
    warnings.push('cnal 行情页抓取失败：' + e.message);
    try {
      latest = await fetchCcmn();
      warnings.push('已回退 ccmn 取今日价');
    } catch (e2) {
      warnings.push('ccmn 兜底失败：' + e2.message);
    }
  }

  // 2) 长江现货 A00 历史
  let series = [];
  try {
    series = await fetchCnalTrend(SERIES_DAYS);
  } catch (e) {
    warnings.push('cnal 历史抓取失败：' + e.message);
  }

  if (!series.length && !latest) throw new Error('长江铝价两个来源均不可用');

  // 3) 把最新价并入序列（同一天以最新价为准）
  const date = (latest && latest.date) || (series.length ? series[series.length - 1].date : todayCN());
  const map = {};
  series.forEach(function (r) {
    map[r.date] = r.price;
  });
  if (latest) map[date] = latest.price;
  series = Object.keys(map)
    .sort()
    .map(function (d) {
      return { date: d, price: map[d] };
    })
    .slice(-SERIES_DAYS);

  if (!latest) {
    const last = series[series.length - 1];
    const prev = series.length > 1 ? series[series.length - 2].price : null;
    latest = {
      price: last.price,
      min: null,
      max: null,
      change: prev === null ? null : last.price - prev,
      date: last.date,
      name: '长江现货 A00铝',
      source: '有色宝长江'
    };
    warnings.push('今日价格回退为历史序列最新一条');
  }

  const prevSmm = series.length > 1 ? series[series.length - 2].price : null;
  const smmPct = prevSmm ? round(((latest.price - prevSmm) / prevSmm) * 100, 2) : null;

  // 4) LME
  let lme = null;
  try {
    lme = await fetchLme(SERIES_DAYS);
  } catch (e) {
    warnings.push('LME 抓取失败：' + e.message);
  }

  // 5) 首页沿用的 7 日 / 40 日
  const trend = series.slice(-7).map(function (r) {
    return { date: r.date, label: r.date.slice(5), price: r.price };
  });
  const history = series.slice(-40).map(function (r) {
    return { date: r.date, price: r.price };
  });

  const now = cnDate(new Date());

  const payload = {
    updated_at: now.full,
    date: date,
    price: latest.price,
    min: latest.min,
    max: latest.max,
    change: latest.change,
    source: latest.source || '长江有色网',
    history_source: '世铝网·有色宝长江',
    trend: trend,
    history: history,
    smm: {
      name: 'SMM 铝价',
      sub_name: '长江现货 A00 铝锭',
      unit: '元/吨',
      currency: 'CNY',
      latest: latest.price,
      min: latest.min,
      max: latest.max,
      change: latest.change,
      change_pct: smmPct,
      source: '有色宝长江 market.cnal.com/changjiang',
      series: series
    },
    lme: lme
      ? {
          name: 'LME 铝价',
          sub_name: 'LME 铝 3M',
          unit: '美元/吨',
          currency: 'USD',
          latest: lme.latest,
          high: lme.high,
          low: lme.low,
          change: lme.change,
          change_pct: lme.change_pct,
          source: lme.source,
          source_note: lme.note,
          series: lme.series
        }
      : null
  };

  return { payload: payload, warnings: warnings };
}

/** 与上一次的输出合并，避免某天抓取失败导致序列变短 */
function mergePrevious(payload, outFile) {
  let old = null;
  try {
    old = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch (e) {
    old = null;
  }
  if (!old) return payload;

  payload.history = mergeSeries(payload.history, old.history, 40);
  if (payload.smm) {
    payload.smm.series = mergeSeries(payload.smm.series, old.smm && old.smm.series, SERIES_DAYS);
  }
  if (payload.lme) {
    payload.lme.series = mergeSeries(payload.lme.series, old.lme && old.lme.series, SERIES_DAYS);
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
  const payload = mergePrevious(r.payload, out);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');

  // 小程序内置快照（离线兜底）
  if (jsOut) {
    fs.mkdirSync(path.dirname(jsOut), { recursive: true });
    fs.writeFileSync(
      jsOut,
      '/* 自动生成，请勿手改：由 tools/fetch_aluminum.js 抓取长江现货 A00 与 LME 铝价 */\n' +
        'module.exports = ' + JSON.stringify(payload, null, 2) + ';\n',
      'utf8'
    );
  }

  console.log('✅ 已生成 ' + out + (jsOut ? ' 与 ' + jsOut : ''));
  console.log(
    '   SMM   ' + payload.date + ' | ' + payload.price + ' 元/吨' +
      (payload.change == null ? '' : ' | 涨跌 ' + payload.change) +
      ' | 序列 ' + (payload.smm ? payload.smm.series.length : 0) + ' 天'
  );
  if (payload.lme) {
    console.log(
      '   LME   ' + payload.lme.series[payload.lme.series.length - 1].date + ' | ' +
        payload.lme.latest + ' 美元/吨' +
        (payload.lme.change == null ? '' : ' | 涨跌 ' + payload.lme.change) +
        ' | 序列 ' + payload.lme.series.length + ' 天 | 源 ' + payload.lme.source
    );
  } else {
    console.log('   LME   未取到');
  }
  if (r.warnings.length) console.warn('⚠️  ' + r.warnings.join('; '));
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('❌ 失败：' + e.message);
    process.exit(1);
  });
}

module.exports = {
  build: build,
  fetchCnalLatest: fetchCnalLatest,
  fetchCcmn: fetchCcmn,
  fetchCnalTrend: fetchCnalTrend,
  fetchLme: fetchLme,
  fetchLmeEmKline: fetchLmeEmKline,
  fetchLmeEmRealtime: fetchLmeEmRealtime,
  fetchLmeSinaKline: fetchLmeSinaKline,
  fetchLmeRealtime: fetchLmeRealtime
};
