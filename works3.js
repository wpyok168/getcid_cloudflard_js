/**
 * IID 激活服务 - 批量日志版（20条/5分钟自动存）
 * 规则：满20条存一次 || 5分钟未存则有数据必存
 */

const KV_NAMESPACE = "KV_LOGS";
const BATCH_SIZE = 20;
const BATCH_FLUSH_SECONDS = 300; // 5分钟

let logBatch = [];
let lastFlushTime = Date.now();

// Base64URL
function eI(t) {
  let e = t instanceof ArrayBuffer ? new Uint8Array(t) : new TextEncoder().encode(t);
  let n = "";
  for (let o of e) n += String.fromCharCode(o);
  return btoa(n).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// 密钥缓存
let tI = null;
async function yT() {
  if (!tI) {
    tI = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  }
  return tI;
}

// DPoP
async function c1e(t, e) {
  try {
    const { privateKey, publicKey } = await yT();
    const jwk = await crypto.subtle.exportKey("jwk", publicKey);
    const header = { alg: "ES256", typ: "dpop+jwt", jwk };
    const payload = { htu: t, htm: e, jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000) };
    const s = eI(JSON.stringify(header));
    const l = eI(JSON.stringify(payload));
    const u = `${s}.${l}`;
    const p = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(u));
    return `${u}.${eI(p)}`;
  } catch (err) {
    throw new Error("DPoP 失败");
  }
}

function GenerateSessionId() {
  return `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

async function safeParse(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function sendActivationRequest(IID) {
  if (!IID) throw new Error("缺少 IID");
  const dpopToken = await c1e("/api/productActivation/validateIID", "POST");
  const sid = GenerateSessionId();
  const digits = Math.floor(IID.length / 9);

  const resp = await fetch("https://visualsupport.microsoft.com/api/productActivation/validateIID", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer govUrlID",
      "DPoP": dpopToken,
      "x-session-id": sid
    },
    body: JSON.stringify({
      IID, ProductType: "windows", productGroup: "Windows", productName: "Windows 11",
      numberOfDigits: digits, Country: "CHN", Region: "APGC", InstalledDevices: 1,
      OverrideStatusCode: "MUL", InitialReasonCode: "45164"
    })
  });
  const data = await safeParse(resp);
  return { status: resp.status, success: resp.ok, data };
}

// ========================
// 批量日志核心
// ========================
async function flushBatch(kv) {
  if (logBatch.length === 0) return;
  const key = `batch_${Date.now()}_${crypto.randomUUID()}`;
  await kv.put(key, JSON.stringify(logBatch));
  logBatch = [];
  lastFlushTime = Date.now();
}

function shouldAutoFlush() {
  return (Date.now() - lastFlushTime) / 1000 > BATCH_FLUSH_SECONDS;
}

// ========================
// 读取所有日志（合并批量）
// ========================
async function getAllLogs(kv) {
  if (!kv) return [];
  const { keys } = await kv.list();
  let logs = [];
  for (const k of keys) {
    const val = await kv.get(k.name);
    if (!val) continue;
    try {
      const arr = JSON.parse(val);
      if (Array.isArray(arr)) logs.push(...arr);
      else logs.push(arr);
    } catch {}
  }
  return logs.sort((a, b) => b.time.localeCompare(a.time));
}

// ========================
// 页面
// ========================
function loginPage() {
  return `<!DOCTYPE html><meta charset="utf-8"><title>登录</title><style>body{display:flex;justify-content:center;align-items:center;height:100vh}.box{padding:2rem;background:white;border-radius:12px;box-shadow:0 2px 10px #00000010;width:320px}input,button{width:100%;padding:10px;margin:8px 0;border-radius:6px;border:1px solid #ddd}button{background:#0066cc;color:white;border:none}</style><div class="box"><h2>日志登录</h2><form method="post"><input type="password" name="pwd" placeholder="密码" required><button>登录</button></form></div>`;
}

function logPage(logs, page, totalPage, search = "", PAGE_SIZE) {
  const start = (page - 1) * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const paginated = logs.slice(start, end);

  const rows = paginated.map((log, idx) => `
  <tr>
    <td>${log.time}</td>
    <td style="font-family:monospace;font-size:12px">${log.IID}</td>
    <td>${log.ip}</td>
    <td>${log.result.success ? "✅成功" : "❌失败"}</td>
    <td>${log.result.status}</td>
    <td>
      <button onclick="showJson(${idx})">详情</button>
      <button onclick="searchIID('${log.IID}')" style="background:#6c757d;margin-left:4px">同IID</button>
    </td>
  </tr>`).join('');

  const logDatas = JSON.stringify(paginated.map(x => x.result));
  const pager = [];
  for (let i=1;i<=totalPage;i++) pager.push(`<a href="?page=${i}&search=${encodeURIComponent(search)}" style="margin:0 5px;color:${page===i?'red':''}">${i}</a>`);

  return `<!DOCTYPE html><meta charset="utf-8"><title>IID日志</title>
<style>
body{font-family:system-ui;margin:2rem;background:#fafafa}
.card{background:white;padding:1.5rem;border-radius:12px;box-shadow:0 2px 8px #000}
.search{display:flex;gap:10px;margin-bottom:1rem}
.search input{flex:1;padding:8px;border:1px solid #ddd;border-radius:6px}
.search button{padding:8px 16px;background:#0066cc;color:white;border:none;border-radius:6px}
table{width:100%;border-collapse:collapse}
th,td{padding:10px;border:1px solid #eee}
th{background:#f8f9fa}
.modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:#00000080}
.modal .inner{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:white;padding:20px;width:90%;max-width:700px;max-height:80vh;overflow:auto;border-radius:8px}
pre{background:#f8f9fa;padding:1rem;border-radius:6px;overflow:auto}
button{padding:4px 8px;border:none;background:#0066cc;color:white;border-radius:4px;cursor:pointer}
.btn-copy{background:#28a745}
.btn-close{background:#6c757d}
.modal-btns{display:flex;gap:8px;margin-bottom:10px}
</style>
<div class="card">
<h1>IID激活日志</h1>
<div class="search">
<input id="search" value="${search}" placeholder="搜索IID">
<button onclick="doSearch()">搜索</button>
</div>
<div style="margin-bottom:1rem">${pager.join('')}</div>
<table>
<tr><th>时间</th><th>IID</th><th>IP</th><th>状态</th><th>状态码</th><th>操作</th></tr>
${rows}
</table>
</div>
<div class="modal" id="modal">
<div class="inner">
<div class="modal-btns">
<button class="btn-copy" onclick="copyJson()">复制JSON</button>
<button class="btn-close" onclick="closeModal()">关闭</button>
</div>
<pre id="json"></pre>
</div>
</div>
<script>
const logsData = ${logDatas};
let currentJson = '';
function doSearch(){location.href='?search='+encodeURIComponent(document.getElementById('search').value)}
function searchIID(iid){location.href='?search='+encodeURIComponent(iid)}
function showJson(i){currentJson=JSON.stringify(logsData[i],null,2);document.getElementById('json').textContent=currentJson;document.getElementById('modal').style.display='block'}
function closeModal(){document.getElementById('modal').style.display='none'}
async function copyJson(){await navigator.clipboard.writeText(currentJson);alert('复制成功')}
</script>
  `;
}

// ========================
// 主入口
// ========================
export default {
  async fetch(request, env, ctx) {
    const LOG_PASSWORD = env.LOG_PASSWORD;
    const PAGE_SIZE = parseInt(env.PAGE_SIZE) || 20;
    const kv = env[KV_NAMESPACE];
    const url = new URL(request.url);
    const path = url.pathname;

    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers });

    // 日志页面
    if (path === "/logs") {
      if (!LOG_PASSWORD) return new Response("请配置 LOG_PASSWORD", { headers: { "Content-Type": "text/html;charset=utf-8" } });
      if (request.method === "POST") {
        const form = await request.formData();
        if (form.get("pwd") === LOG_PASSWORD) {
          return new Response(null, { status: 302, headers: { "Location": "/logs", "Set-Cookie": `log_token=${LOG_PASSWORD}; Path=/logs; HttpOnly; Max-Age=86400; SameSite=Lax` } });
        }
      }
      const cookie = request.headers.get("cookie") || "";
      if (!cookie.includes(`log_token=${LOG_PASSWORD}`)) return new Response(loginPage(), { headers: { "Content-Type": "text/html;charset=utf-8" } });
      const search = url.searchParams.get("search") || "";
      const page = parseInt(url.searchParams.get("page")) || 1;
      let logs = await getAllLogs(kv);
      if (search) logs = logs.filter(x => x.IID.includes(search));
      const totalPage = Math.ceil(logs.length / PAGE_SIZE);
      return new Response(logPage(logs, page, totalPage, search, PAGE_SIZE), { headers: { "Content-Type": "text/html;charset=utf-8" } });
    }

    // 接口
    if (request.method !== "POST") return Response.json({ error: "仅支持 POST" }, { status: 405, headers });

    try {
      const body = await request.json();
      const { IID } = body;
      if (!IID) return Response.json({ error: "缺少 IID" }, { status: 400, headers });

      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const result = await sendActivationRequest(IID);

      // 加入批量日志
      logBatch.push({
        time: new Date().toISOString(),
        IID,
        ip,
        result
      });

      // 触发存储
      if (logBatch.length >= BATCH_SIZE || shouldAutoFlush()) {
        ctx.waitUntil(flushBatch(kv));
      }

      return Response.json(result, { headers });
    } catch (err) {
      return Response.json({ error: "服务异常", detail: err.message }, { status: 500, headers });
    }
  }
};
