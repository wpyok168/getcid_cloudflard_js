/**
 * 最终优化版 · IID 激活服务
 * 修复1101 + KV日志 + 环境变量密码 + 24h Cookie + 搜索+分页+JSON查看
 */

// ===================== 配置项 =====================
const KV_NAMESPACE = "KV_LOGS";         // KV绑定名
// ==================================================

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
    return `${u}.${eI(p)}`;
  } catch (err) {
    throw new Error("DPoP 生成失败: " + err.message);
  }
}

// Session ID
function GenerateSessionId() {
  return `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

// 安全解析
async function safeParse(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
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
    throw new Error("请求失败: " + e.message);
  }

  const data = await safeParse(resp);
  return { status: resp.status, success: resp.ok, data };
}

// 写入日志
async function writeLog(kv, IID, result, ip) {
  const id = `log_${Date.now()}_${crypto.randomUUID()}`;
  const log = { time: new Date().toISOString(), IID, ip, result };
  try { await kv.put(id, JSON.stringify(log)); } catch (e) {}
}

// 获取日志
async function getAllLogs(kv) {
  const { keys } = await kv.list();
  const logs = [];
  for (const k of keys) {
    const val = await kv.get(k.name);
    if (val) logs.push(JSON.parse(val));
  }
  return logs.sort((a, b) => b.time.localeCompare(a.time));
}

// 登录页
function loginPage(showError = false) {
  return `
<!DOCTYPE html>
<meta charset="utf-8">
<title>日志登录</title>
<style>
  body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f4f6f8}
  .box{padding:2rem;background:white;border-radius:12px;box-shadow:0 2px 10px #00000010;width:320px}
  h2{margin-top:0}
  .err{color:red;text-align:center;margin-bottom:10px}
  input{width:100%;padding:10px;margin:10px 0;box-sizing:border-box;border:1px solid #ddd;border-radius:6px}
  button{width:100%;padding:10px;background:#0066cc;color:white;border:none;border-radius:6px;cursor:pointer}
</style>
<div class="box">
  <h2>日志访问验证</h2>
  ${showError ? '<div class="err">密码错误</div>' : ''}
  <form method="POST">
    <input type="password" name="pwd" placeholder="请输入密码" required>
    <button>登录</button>
  </form>
</div>
  `;
}

// 未配置密码提示页
function needSetupPasswordPage() {
  return `
<!DOCTYPE html>
<meta charset="utf-8">
<title>未配置密码</title>
<style>
  body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f4f6f8}
  .box{padding:2rem;background:white;border-radius:12px;box-shadow:0 2px 10px #00000010;width:320px;text-align:center}
  h2{color:red}
  p{font-size:14px;color:#666}
</style>
<div class="box">
  <h2>⚠️ 未配置登录密码</h2>
  <p>请在 Cloudflare Worker 环境变量中配置：</p>
  <p><strong>LOG_PASSWORD</strong></p>
</div>
  `;
}

// 日志页面
function logPage(logs, page, totalPage, search = "", PAGE_SIZE) {
  const start = (page - 1) * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const paginated = logs.slice(start, end);

  const rows = paginated.map(log => `
  <tr>
    <td>${log.time}</td>
    <td style="font-family:monospace;font-size:12px">${log.IID}</td>
    <td>${log.ip}</td>
    <td>${log.result.success ? '✅成功' : '❌失败'}</td>
    <td>${log.result.status}</td>
    <td><button onclick="showJson(${JSON.stringify(JSON.stringify(log.result, null, 2))})">查看详情</button></td>
  </tr>`).join('');

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
  .modal .inner{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:white;padding:20px;width:90%;max-width:700px;max-height:80vh;overflow:auto;border-radius:8px}
  pre{background:#f8f9fa;padding:1rem;border-radius:6px;overflow:auto}
  button{padding:6px 10px;border:none;background:#0066cc;color:white;border-radius:4px;cursor:pointer}
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
    <button onclick="closeModal()">关闭</button>
    <pre id="json"></pre>
  </div>
</div>
<script>
  function doSearch(){ location.href='?search='+encodeURIComponent(document.getElementById('search').value); }
  function showJson(json){ document.getElementById('json').textContent = json; document.getElementById('modal').style.display='block'; }
  function closeModal(){ document.getElementById('modal').style.display='none'; }
</script>
  `;
}

// 主入口
export default {
  async fetch(request, env) {
    // 从环境变量读取所有可配置项
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

    // ========== 日志页面 ==========
    if (path === "/logs") {
      // 未配置密码 → 提示设置
      if (!LOG_PASSWORD) {
        return new Response(needSetupPasswordPage(), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      // 登录提交
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
        return new Response(loginPage(true), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      // 验证登录状态
      const cookie = request.headers.get("cookie") || "";
      if (!cookie.includes(`log_token=${LOG_PASSWORD}`)) {
        return new Response(loginPage(), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      // 加载日志
      const search = url.searchParams.get("search") || "";
      const page = parseInt(url.searchParams.get("page")) || 1;
      let logs = await getAllLogs(kv);
      if (search) logs = logs.filter(x => x.IID.includes(search));
      const totalPage = Math.ceil(logs.length / PAGE_SIZE);

      return new Response(logPage(logs, page, totalPage, search, PAGE_SIZE), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // ========== 业务接口 ==========
    if (request.method !== "POST") {
      return Response.json({ error: "仅支持 POST" }, { status: 405, headers });
    }

    try {
      const body = await request.json();
      const { IID } = body;
      if (!IID) return Response.json({ error: "缺少 IID" }, { status: 400, headers });

      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const result = await sendActivationRequest(IID);
      writeLog(kv, IID, result, ip).catch(() => {});

      return Response.json(result, { headers });
    } catch (err) {
      return Response.json({ error: "服务异常", detail: err.message }, { status: 500, headers });
    }
  }
};
