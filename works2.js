/**
 * 最终稳定版：日志100%存储 + 详情弹窗 + 复制功能
 */

// ===================== 配置项 =====================
const KV_NAMESPACE = "KV_LOGS";
// ==================================================

// Base64URL
function eI(t) {
  let e = t instanceof ArrayBuffer ? new Uint8Array(t) : new TextEncoder().encode(t);
  let n = "";
  for (let o of e) n += String.fromCharCode(o);
  return btoa(n).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// 全局密钥对缓存
let tI = null;
async function yT() {
  if (!tI) {
    tI = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );
  }
  return tI;
}

// DPoP
async function c1e(t, e) {
  try {
    const { privateKey, publicKey } = await yT();
    const jwk = await crypto.subtle.exportKey("jwk", publicKey);

    const header = { alg: "ES256", typ: "dpop+jwt", jwk };
    const payload = {
      htu: t,
      htm: e,
      jti: crypto.randomUUID(),
      iat: Math.floor(Date.now() / 1000)
    };

    const s = eI(JSON.stringify(header));
    const l = eI(JSON.stringify(payload));
    const u = `${s}.${l}`;

    const p = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      new TextEncoder().encode(u)
    );

    const g = eI(p);
    return `${u}.${g}`;
  } catch (err) {
    throw new Error("DPoP生成失败: " + err.message);
  }
}

// Session ID
function GenerateSessionId() {
  return `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

// 安全解析
async function safeParse(resp) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// 核心请求
async function sendActivationRequest(IID) {
  if (!IID || !IID.trim()) throw new Error("缺少有效 IID");

  const dpopToken = await c1e("/api/productActivation/validateIID", "POST");
  const sid = GenerateSessionId();
  const digits = Math.floor(IID.length / 9);

  let resp;
  try {
    resp = await fetch("https://visualsupport.microsoft.com/api/productActivation/validateIID", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer govUrlID",
        "DPoP": dpopToken,
        "x-session-id": sid
      },
      body: JSON.stringify({
        IID,
        ProductType: "windows",
        productGroup: "Windows",
        productName: "Windows 11",
        numberOfDigits: digits,
        Country: "CHN",
        Region: "APGC",
        InstalledDevices: 1,
        OverrideStatusCode: "MUL",
        InitialReasonCode: "45164"
      })
    });
  } catch (e) {
    throw new Error("fetch失败: " + e.message);
  }

  const data = await safeParse(resp);
  return { status: resp.status, success: resp.ok, data };
}

// 写入KV日志（加固：完整错误捕获 + 重试机制）
async function writeLog(kv, IID, result, ip) {
  if (!kv) {
    console.error("❌ KV 绑定未找到，无法写入日志");
    return;
  }
  const id = `log_${Date.now()}_${crypto.randomUUID()}`;
  const log = { time: new Date().toISOString(), IID, ip, result };
  
  // 增加重试机制，确保写入成功
  for (let i = 0; i < 3; i++) {
    try {
      await kv.put(id, JSON.stringify(log));
      console.log(`✅ 日志写入成功: ${id}`);
      return;
    } catch (e) {
      console.error(`❌ KV 写入失败(第${i+1}次):`, e);
      await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
    }
  }
}

// 获取所有日志
async function getAllLogs(kv) {
  if (!kv) return [];
  const { keys } = await kv.list();
  const logs = [];
  for (const k of keys) {
    const val = await kv.get(k.name);
    if (val) logs.push(JSON.parse(val));
  }
  return logs.sort((a, b) => b.time.localeCompare(a.time));
}

// 密码页面
function loginPage() {
  return `
<!DOCTYPE html>
<meta charset="utf-8">
<title>日志登录</title>
<style>
  body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f4f6f8}
  .box{padding:2rem;background:white;border-radius:12px;box-shadow:0 2px 10px #00000010;width:320px}
  h2{margin-top:0}
  input{width:100%;padding:10px;margin:10px 0;box-sizing:border-box;border:1px solid #ddd;border-radius:6px}
  button{width:100%;padding:10px;background:#0066cc;color:white;border:none;border-radius:6px;cursor:pointer}
</style>
<div class="box">
  <h2>日志访问验证</h2>
  <form method="POST">
    <input type="password" name="pwd" placeholder="请输入密码" required>
    <button>登录查看日志</button>
  </form>
</div>
  `;
}

// 日志页面（搜索+分页+JSON查看+复制）
function logPage(logs, page, totalPage, search = "", PAGE_SIZE) {
  const start = (page - 1) * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const paginated = logs.slice(start, end);

  const rows = paginated.map((log, idx) => `
  <tr>
    <td>${log.time}</td>
    <td style="font-family:monospace;font-size:12px">${log.IID}</td>
    <td>${log.ip}</td>
    <td>${log.result.success ? '✅成功' : '❌失败'}</td>
    <td>${log.result.status}</td>
    <td><button onclick="showJson(${idx})">查看详情</button></td>
  </tr>
  `).join('');

  const logDataList = JSON.stringify(paginated.map(x => x.result));

  const pager = [];
  for (let i = 1; i <= totalPage; i++) {
    pager.push(`<a href="?page=${i}&search=${encodeURIComponent(search)}" style="margin:0 5px;color:${page === i ? 'red' : ''}">${i}</a>`);
  }

  return `
<!DOCTYPE html>
<meta charset="utf-8">
<title>IID 激活日志</title>
<style>
  body{font-family:system-ui;margin:2rem;background:#fafafa}
  .card{background:white;padding:1.5rem;border-radius:12px;box-shadow:0 2px 8px #00000010}
  .search{margin-bottom:1rem;display:flex;gap:10px}
  .search input{flex:1;padding:8px;border:1px solid #ddd;border-radius:6px}
  .search button{padding:8px 16px;background:#0066cc;color:white;border:none;border-radius:6px}
  table{width:100%;border-collapse:collapse;margin-top:1rem}
  th,td{padding:10px;border:1px solid #eee;text-align:left}
  th{background:#f8f9fa}
  .pager{margin-top:1rem}
  .modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:#00000080}
  .modal .inner{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
    background:white;padding:20px;width:90%;max-width:700px;max-height:80vh;overflow:auto;border-radius:8px}
  pre{background:#f8f9fa;padding:1rem;border-radius:6px;overflow:auto;white-space:pre-wrap}
  button{padding:6px 10px;border:none;background:#0066cc;color:white;border-radius:4px;cursor:pointer}
  .btn-copy{background:#28a745}
  .btn-close{background:#6c757d}
  .modal-btns{display:flex;gap:8px;margin-bottom:10px}
</style>
<div class="card">
  <h1>IID 激活请求日志</h1>
  <div class="search">
    <input id="search" value="${search}" placeholder="搜索 IID...">
    <button onclick="doSearch()">搜索</button>
  </div>
  <div class="pager">${pager.join('')}</div>
  <table>
    <tr><th>时间</th><th>IID</th><th>IP</th><th>状态</th><th>状态码</th><th>详情</th></tr>
    ${rows}
  </table>
</div>
<div class="modal" id="modal">
  <div class="inner">
    <div class="modal-btns">
      <button class="btn-copy" onclick="copyJson()">📋 复制JSON</button>
      <button class="btn-close" onclick="closeModal()">关闭</button>
    </div>
    <pre id="json"></pre>
  </div>
</div>
<script>
  const logResults = ${logDataList};
  let currentJson = '';

  function doSearch(){
    const s = document.getElementById('search').value;
    location.href='?search='+encodeURIComponent(s);
  }

  function showJson(idx){
    const data = logResults[idx];
    currentJson = JSON.stringify(data, null, 2);
    document.getElementById('json').textContent = currentJson;
    document.getElementById('modal').style.display='block';
  }

  function closeModal(){
    document.getElementById('modal').style.display='none';
  }

  async function copyJson(){
    if(!currentJson) return;
    await navigator.clipboard.writeText(currentJson);
    alert('复制成功！');
  }
</script>
  `;
}

// 主Worker（加固：异常请求也强制写入日志）
export default {
  async fetch(request, env, ctx) {
    const LOG_PASSWORD = env.LOG_PASSWORD;
    const COOKIE_EXPIRE_HOURS = parseInt(env.COOKIE_EXPIRE_HOURS) || 24;
    const PAGE_SIZE = parseInt(env.PAGE_SIZE) || 20;
    const COOKIE_EXPIRE = COOKIE_EXPIRE_HOURS * 3600;
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
      if (!LOG_PASSWORD) {
        return new Response(`<body style="padding:2rem"><h2>请配置 LOG_PASSWORD 环境变量</h2></body>`, {
          headers: { "Content-Type": "text/html;charset=utf-8" }
        });
      }

      if (request.method === "POST") {
        const form = await request.formData();
        const pwd = form.get("pwd");
        if (pwd === LOG_PASSWORD) {
          return new Response(null, {
            status: 302,
            headers: {
              "Location": "/logs",
              "Set-Cookie": `log_token=${LOG_PASSWORD}; Path=/logs; HttpOnly; Max-Age=${COOKIE_EXPIRE}; SameSite=Lax`
            }
          });
        }
      }

      const cookie = request.headers.get("cookie") || "";
      if (!cookie.includes(`log_token=${LOG_PASSWORD}`)) {
        return new Response(loginPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const search = url.searchParams.get("search") || "";
      const page = parseInt(url.searchParams.get("page")) || 1;
      let logs = await getAllLogs(kv);
      if (search) logs = logs.filter(x => x.IID.includes(search));
      const totalPage = Math.ceil(logs.length / PAGE_SIZE);
      return new Response(logPage(logs, page, totalPage, search, PAGE_SIZE), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // 业务接口
    if (request.method !== "POST") {
      return Response.json({ error: "仅支持POST" }, { status: 405, headers });
    }

    let body, IID, ip, result;
    try {
      body = await request.json();
      IID = body.IID;
      if (!IID) throw new Error("缺少IID");

      ip = request.headers.get("cf-connecting-ip") || "unknown";
      result = await sendActivationRequest(IID);
      
      // 正常请求写入日志
      ctx.waitUntil(writeLog(kv, IID, result, ip));

      return Response.json(result, { headers });
    } catch (err) {
      // 异常请求也强制写入日志
      const errorResult = {
        error: "服务异常",
        detail: err.message,
        status: 500,
        success: false,
        requestBody: body || {}
      };
      ctx.waitUntil(writeLog(kv, IID || "empty", errorResult, ip || "unknown"));
      
      return Response.json(errorResult, { status: 500, headers });
    }
  }
};
