/**
 * IID 激活服务 - 最终稳定版
 * 基于 UUID 精准删除 | 解决无状态/多实例/序号偏移问题
 * 批量20条/5分钟 | 时区 | 单条删除 | 清空 | 同IID筛选
 */

const KV_NAMESPACE = "KV_LOGS";
const BATCH_SIZE = 20;
const BATCH_FLUSH_SECONDS = 300;
const MAX_BATCH_READ = 50;

let logBatch = [];
let lastFlushTime = Date.now();
let flushing = false;

// 安全 Cookie 校验
function isAuth(request, pwd) {
  const cookie = request.headers.get("cookie") || "";
  return cookie.split(";").some(c => c.trim() === `log_token=${pwd}`);
}

// Base64URL
function eI(t) {
  let e = t instanceof ArrayBuffer ? new Uint8Array(t) : new TextEncoder().encode(t);
  let n = "";
  for (let o of e) n += String.fromCharCode(o);
  return btoa(n).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// 密钥缓存（✅ 已修复变量错误）
let tI = null;
async function yT() {
  if (!tI) {
    tI = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  }
  return tI;
}

// DPoP
async function c1(t, e) {
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
    throw new Error("DPoP 生成失败");
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
  const dpopToken = await c1("/api/productActivation/validateIID", "POST");
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
      numberOfDigits: digits, Country: "CHN", Region: "APAC", InstalledDevices: 1,
      OverrideStatusCode: "MUL", InitialReasonCode: "45164"
    })
  });
  const data = await safeParse(resp);
  return { status: resp.status, success: resp.ok, data };
}

// 时区时间
function getFormatTime(tzOffset) {
  const offset = parseInt(tzOffset) || 8;
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const tzTime = new Date(utc + 3600000 * offset);
  return tzTime.toISOString().replace("T", " ").slice(0, 19);
}

// 批量写入（并发锁）
async function flushBatch(kv) {
  if (flushing || logBatch.length === 0) return;
  flushing = true;
  try {
    const batchId = `batch_${Date.now()}_${crypto.randomUUID()}`;
    await kv.put(batchId, JSON.stringify(logBatch));
    logBatch = [];
    lastFlushTime = Date.now();
  } finally {
    flushing = false;
  }
}

function needFlush() {
  if (logBatch.length >= BATCH_SIZE) return true;
  return (Date.now() - lastFlushTime) / 1000 > BATCH_FLUSH_SECONDS && logBatch.length > 0;
}

// 直接读取最新批次（利用 KV 字典序）
async function getAllLogs(kv) {
  if (!kv) return [];
  const { keys } = await kv.list({ limit: MAX_BATCH_READ });
  
  let all = [];
  for (const key of keys) {
    const val = await kv.get(key.name);
    if (!val) continue;
    try {
      const data = JSON.parse(val);
      if (Array.isArray(data)) all.push(...data);
    } catch {}
  }
  return all.sort((a, b) => b.time.localeCompare(a.time));
}

// 精准删除
async function deleteLogById(kv, targetId) {
  if (!kv || !targetId) return false;
  const { keys } = await kv.list({ limit: 100 });
  for (const key of keys) {
    const val = await kv.get(key.name);
    if (!val) continue;
    try {
      let logs = JSON.parse(val);
      if (!Array.isArray(logs)) continue;
      const beforeLen = logs.length;
      logs = logs.filter(x => x.id !== targetId);
      if (logs.length < beforeLen) {
        if (logs.length === 0) await kv.delete(key.name);
        else await kv.put(key.name, JSON.stringify(logs));
        return true;
      }
    } catch {}
  }
  return false;
}

// 清空
async function clearAllLogs(kv) {
  let cursor;
  do {
    const res = await kv.list({ cursor });
    cursor = res.cursor;
    await Promise.all(res.keys.map(k => kv.delete(k.name)));
  } while (cursor);
}

// ==============================
// 页面
// ==============================
function loginPage() {
  return `<!DOCTYPE html><meta charset="utf-8"><title>登录</title>
<style>body{display:flex;justify-content:center;align-items:center;height:100vh}.box{padding:2rem;background:white;border-radius:12px;box-shadow:0 2px 10px #000;width:320px}input,button{width:100%;padding:10px;margin:8px 0;border-radius:6px;border:1px solid #ddd}button{background:#0066cc;color:white;border:none}</style>
<div class="box"><h2>日志登录</h2><form method="post"><input type="password" name="pwd" required><button>登录</button></form></div>`;
}

function logPage(logs, page, totalPage, search, PAGE_SIZE) {
  const start = (page - 1) * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const paginated = logs.slice(start, end);

  const rows = paginated.map((log) => `
  <tr>
    <td>${log.time}</td>
    <td style="font-family:monospace">${log.IID}</td>
    <td>${log.ip}</td>
    <td>${log.result.success ? "✅成功" : "❌失败"}</td>
    <td>${log.result.status}</td>
    <td style="white-space:nowrap">
      <button onclick="show('${log.id}')">详情</button>
      <button onclick="go('${log.IID}')" style="background:#6c757d;margin-left:4px">同IID</button>
      <button onclick="del('${log.id}')" style="background:red;margin-left:4px">删除</button>
    </td>
  </tr>`).join("");

  const logData = JSON.stringify(paginated);
  const pages = Array.from({ length: totalPage }, (_, i) =>
    `<a href="?page=${i+1}&search=${encodeURIComponent(search)}" style="margin:0 5px;color:${page===i+1?'red':''}">${i+1}</a>`
  );

  return `<!DOCTYPE html><meta charset="utf-8"><title>IID日志</title>
<style>
body{font-family:system-ui;margin:2rem;background:#fafafa}
.card{background:white;padding:1.5rem;border-radius:12px;box-shadow:0 2px 8px #000}
.search{display:flex;gap:10px;margin-bottom:1rem}
.search input{flex:1;padding:8px;border:1px solid #ddd;border-radius:6px}
.search button{background:#0066cc;color:white;border:none;border-radius:6px}
table{width:100%;border-collapse:collapse}
th,td{padding:10px;border:1px solid #eee}
.modal{display:none;position:fixed;inset:0;background:#00000080}
.modal .inner{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:white;padding:20px;width:90%;max-width:700px;overflow:auto;border-radius:8px}
pre{background:#f8f9fa;padding:1rem;border-radius:6px;overflow:auto}
button{padding:4px 8px;border:none;background:#0066cc;color:white;border-radius:4px;cursor:pointer}
.btn-copy{background:#28a745}
.btn-close{background:#6c757d}
.btn-clear{background:red;padding:6px 10px}
.btns{display:flex;gap:8px;margin-bottom:10px}
</style>
<div class="card">
<h1>IID激活日志</h1>
<div style="display:flex;gap:10px;margin-bottom:1rem;">
  <button class="btn-clear" onclick="clearAll()">清空所有日志</button>
</div>
<div class="search">
<input id="s" value="${search}" placeholder="搜索IID">
<button onclick="search()">搜索</button>
</div>
<div style="margin-bottom:1rem">${pages.join("")}</div>
<table>
<tr><th>时间</th><th>IID</th><th>IP</th><th>状态</th><th>状态码</th><th>操作</th></tr>
${rows}
</table>
</div>
<div class="modal" id="m">
<div class="inner">
<div class="btn-group">
<button class="btn-copy" onclick="copy()">复制JSON</button>
<button class="btn-close" onclick="closeM()">关闭</button>
</div>
<pre id="json"></pre>
</div>
</div>
<script>
const logs=${logData};
function search(){location.href="?search="+encodeURIComponent(document.getElementById("s").value)}
function go(iid){location.href="?search="+encodeURIComponent(iid)}

function show(id){
  const log=logs.find(x=>x.id===id);
  if(!log)return;
  document.getElementById("json").textContent=JSON.stringify(log.result,null,2);
  document.getElementById("m").style.display="block";
}

function closeM(){document.getElementById("m").style.display="none"}
async function copy(){await navigator.clipboard.writeText(document.getElementById("json").textContent);alert("复制成功")}

async function del(id){
  if(!confirm("确定删除？")) return;
  await fetch("/logs/delete",{method:"POST",body:id});
  location.reload();
}

async function clearAll(){
  if(!confirm("确定清空所有？不可恢复！")) return;
  await fetch("/logs/clear",{method:"POST"});
  location.reload();
}
</script>`;
}

// ==============================
// 主入口
// ==============================
export default {
  async fetch(request, env, ctx) {
    const LOG_PASSWORD = env.LOG_PASSWORD;
    const PAGE_SIZE = parseInt(env.PAGE_SIZE) || 20;
    const TIMEZONE_OFFSET = env.TIMEZONE_OFFSET;
    const kv = env[KV_NAMESPACE];
    const url = new URL(request.url);
    const path = url.pathname;

    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers });

    if (path === "/logs/clear") {
      if (!isAuth(request, LOG_PASSWORD)) return new Response("403", { status: 403 });
      await clearAllLogs(kv);
      return new Response("ok");
    }

    if (path === "/logs/delete") {
      if (!isAuth(request, LOG_PASSWORD)) return new Response("403", { status: 403 });
      const id = await request.text();
      await deleteLogById(kv, id);
      return new Response("ok");
    }

    if (path === "/logs") {
      if (!LOG_PASSWORD) return new Response("请配置 LOG_PASSWORD", { headers: { "Content-Type": "text/html;charset=utf-8" } });
      if (request.method === "POST") {
        const form = await request.formData();
        if (form.get("pwd") === LOG_PASSWORD) {
          return new Response(null, {
            status: 302,
            headers: {
              "Location": "/logs",
              "Set-Cookie": `log_token=${LOG_PASSWORD}; Path=/logs; HttpOnly; Max-Age=86400; SameSite=Lax`
            }
          });
        }
      }
      if (!isAuth(request, LOG_PASSWORD)) return new Response(loginPage(), { headers: { "Content-Type": "text/html;charset=utf-8" } });
      
      await flushBatch(kv);
      
      const search = url.searchParams.get("search") ?? "";
      const page = parseInt(url.searchParams.get("page") ?? "1") || 1;
      const logs = await getAllLogs(kv);
      const filtered = search ? logs.filter(x => x.IID.includes(search)) : logs;
      const totalPage = Math.ceil(filtered.length / PAGE_SIZE);
      return new Response(logPage(filtered, page, totalPage, search, PAGE_SIZE), { headers: { "Content-Type": "text/html;charset=utf-8" } });
    }

    if (request.method !== "POST") return Response.json({ error: "仅支持 POST" }, { status: 405, headers });

    try {
      const body = await request.json();
      const { IID } = body;
      if (!IID) return Response.json({ error: "缺少 IID" }, { status: 400, headers });

      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const result = await sendActivationRequest(IID);

      logBatch.push({
        id: crypto.randomUUID(),
        time: getFormatTime(TIMEZONE_OFFSET),
        IID, ip, result
      });

      if (needFlush()) {
        ctx.waitUntil(flushBatch(kv));
      }

      return Response.json(result, { headers });
    } catch (err) {
      return Response.json({ error: "服务异常", detail: err.message }, { status: 500, headers });
    }
  }
};
