/**
 * 修复版：仅解决 1101，不改 DPoP 逻辑
 */

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

// DPoP（保持你原逻辑）
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

// ✅ 安全解析（关键修复点）
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

    // ✅ 不再直接 resp.json()
    const data = await safeParse(resp);

    return {
        status: resp.status,
        success: resp.ok,
        data
    };
}

// Worker
export default {
    async fetch(request) {
        const headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { headers });
        }

        if (request.method !== "POST") {
            return new Response(JSON.stringify({ error: "仅支持 POST" }), {
                status: 405,
                headers: { ...headers, "Content-Type": "application/json" }
            });
        }

        try {
            let body;
            try {
                body = await request.json();
            } catch {
                throw new Error("请求体必须是合法 JSON");
            }

            const { IID } = body;
            if (!IID) throw new Error("缺少 IID");

            const result = await sendActivationRequest(IID);

            return new Response(JSON.stringify(result, null, 2), {
                status: 200,
                headers: { ...headers, "Content-Type": "application/json" }
            });

        } catch (err) {
            // ✅ 确保任何异常都返回（避免 1101）
            return new Response(JSON.stringify({
                error: "服务异常",
                detail: err.message
            }), {
                status: 500,
                headers: { ...headers, "Content-Type": "application/json" }
            });
        }
    }
};
