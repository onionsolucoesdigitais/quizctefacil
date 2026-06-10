const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_PASSWORD = "Tfa2026";
const ADMIN_COOKIE = "ctefacil_admin";
const ADMIN_COOKIE_VALUE = crypto.createHash("sha256").update("ctefacil_admin:" + ADMIN_PASSWORD).digest("hex");

const state = {
  events: [],
  sessions: new Map(),
  leads: new Map(),
  sseClients: new Set(),
};

function now() {
  return Date.now();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        data = data.slice(0, 2_000_000);
      }
    });
    req.on("end", () => resolve(data));
  });
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  raw.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx <= 0) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  });
  return out;
}

function parseFormUrlEncoded(text) {
  const params = new URLSearchParams(String(text || ""));
  const out = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

function isAdminAuthorized(req) {
  const cookies = parseCookies(req);
  return cookies[ADMIN_COOKIE] === ADMIN_COOKIE_VALUE;
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res, code, body, contentType) {
  const b = String(body || "");
  res.writeHead(code, {
    "Content-Type": (contentType || "text/plain") + "; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(b),
  });
  res.end(b);
}

function serveFile(res, filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const type =
      ext === ".html"
        ? "text/html"
        : ext === ".png"
          ? "image/png"
          : ext === ".js"
            ? "text/javascript"
            : ext === ".css"
              ? "text/css"
              : "application/octet-stream";
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": stat.size,
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600",
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (_) {
    text(res, 404, "Not found");
  }
}

function upsertSession(sessionId, reqMeta) {
  const ts = now();
  const existing = state.sessions.get(sessionId);
  if (existing) {
    existing.lastSeenAt = ts;
    existing.ip = reqMeta.ip || existing.ip;
    existing.ua = reqMeta.ua || existing.ua;
    return existing;
  }
  const s = {
    sessionId,
    firstSeenAt: ts,
    lastSeenAt: ts,
    ip: reqMeta.ip || null,
    ua: reqMeta.ua || null,
    lastEvent: null,
    lastView: null,
    eventCount: 0,
    quizMaxStep: 0,
    quizStartedAt: null,
    leadAt: null,
    videoAt: null,
    offerAt: null,
    checkoutAt: null,
    selectedPlanKey: null,
  };
  state.sessions.set(sessionId, s);
  return s;
}

function recordEvent(input, reqMeta) {
  const ts = typeof input.ts === "number" ? input.ts : now();
  const sessionId = String(input.sessionId || "").trim();
  if (!sessionId) return null;

  const s = upsertSession(sessionId, reqMeta);
  const eventName = String(input.event || "").trim();
  const payload = input.payload && typeof input.payload === "object" ? input.payload : {};

  const e = {
    id: crypto.randomUUID(),
    ts,
    receivedAt: now(),
    sessionId,
    event: eventName || "Unknown",
    view: payload && typeof payload.view === "string" ? payload.view : null,
    payload,
    ip: reqMeta.ip || null,
    ua: reqMeta.ua || null,
  };

  state.events.push(e);
  if (state.events.length > 50_000) state.events.splice(0, state.events.length - 50_000);

  s.eventCount += 1;
  s.lastEvent = e.event;
  if (e.view) s.lastView = e.view;

  if (e.event === "QuizStart") {
    s.quizStartedAt = s.quizStartedAt || e.ts;
    s.quizMaxStep = Math.max(s.quizMaxStep, 1);
  }
  if (e.event === "QuizStep" && typeof payload.step === "number") {
    s.quizMaxStep = Math.max(s.quizMaxStep, payload.step);
  }
  if (e.event === "Lead") {
    s.leadAt = e.ts;
  }
  if (e.event === "View" && payload.view === "viewVideo") {
    s.videoAt = e.ts;
  }
  if (e.event === "ViewOffer") {
    s.offerAt = e.ts;
  }
  if (e.event === "InitiateCheckout") {
    s.checkoutAt = e.ts;
  }
  if (e.event === "SelectPlan" && typeof payload.plan_key === "string") {
    s.selectedPlanKey = payload.plan_key;
  }
  if (e.event === "ViewOffer" && payload.recommended_plan) {
    s.selectedPlanKey = payload.recommended_plan;
  }

  if (e.event === "Lead") {
    const lead = {
      sessionId,
      createdAt: e.ts,
      name: payload.name || null,
      whatsapp: payload.whatsapp || null,
      cnpj: payload.cnpj || null,
      perfil: payload.perfil || null,
      volume: payload.volume || null,
      emissao_atual: payload.emissao_atual || null,
      dificuldade: payload.dificuldade || null,
      certificado: payload.certificado || null,
      answersOther: payload.answersOther || null,
    };
    state.leads.set(sessionId, lead);
  }

  for (const client of state.sseClients) {
    try {
      client.write("event: track\n");
      client.write("data: " + JSON.stringify(e) + "\n\n");
    } catch (_) {}
  }

  return e;
}

function getLiveSessions() {
  const ts = now();
  const out = [];
  for (const s of state.sessions.values()) {
    if (ts - s.lastSeenAt <= 15_000) out.push(s);
  }
  out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return out;
}

function getFunnelStats() {
  let sessionsTotal = state.sessions.size;
  let quizStarted = 0;
  let quizStep2 = 0;
  let quizStep3 = 0;
  let quizStep4 = 0;
  let quizStep5 = 0;
  let lead = 0;
  let video = 0;
  let offer = 0;
  let checkout = 0;

  for (const s of state.sessions.values()) {
    if (s.quizStartedAt) quizStarted += 1;
    if (s.quizMaxStep >= 2) quizStep2 += 1;
    if (s.quizMaxStep >= 3) quizStep3 += 1;
    if (s.quizMaxStep >= 4) quizStep4 += 1;
    if (s.quizMaxStep >= 5) quizStep5 += 1;
    if (s.leadAt) lead += 1;
    if (s.videoAt) video += 1;
    if (s.offerAt) offer += 1;
    if (s.checkoutAt) checkout += 1;
  }

  const ts = now();
  const staleMs = 60_000;
  const abandoned = {
    quiz: 0,
    lead: 0,
    video: 0,
    offer: 0,
  };

  for (const s of state.sessions.values()) {
    if (!s.quizStartedAt) continue;
    const inactive = ts - s.lastSeenAt > staleMs;
    if (!inactive) continue;
    if (s.quizStartedAt && !s.leadAt) abandoned.quiz += 1;
    else if (s.leadAt && !s.videoAt) abandoned.lead += 1;
    else if (s.videoAt && !s.offerAt) abandoned.video += 1;
    else if (s.offerAt && !s.checkoutAt) abandoned.offer += 1;
  }

  return {
    sessionsTotal,
    funnel: {
      quizStarted,
      quizStep2,
      quizStep3,
      quizStep4,
      quizStep5,
      lead,
      video,
      offer,
      checkout,
    },
    abandoned,
  };
}

const adminHtml = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CT-e Fácil - Admin</title>
    <style>
      :root { --bg:#0b1220; --card:#0f172a; --muted:#94a3b8; --text:#e2e8f0; --border:rgba(148,163,184,.18); --good:#22c55e; --warn:#f59e0b; --bad:#ef4444; }
      body{margin:0;font-family:Arial,Helvetica,sans-serif;background:linear-gradient(180deg,var(--bg),#020617);color:var(--text);}
      header{padding:18px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;}
      h1{margin:0;font-size:18px;}
      .muted{color:var(--muted);font-size:13px;font-weight:600}
      .wrap{max-width:1200px;margin:0 auto;padding:18px;}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
      .card{background:rgba(15,23,42,.92);border:1px solid var(--border);border-radius:10px;padding:14px;}
      .card h2{margin:0 0 10px;font-size:15px}
      table{width:100%;border-collapse:collapse}
      th,td{padding:10px 8px;border-bottom:1px solid var(--border);font-size:13px;vertical-align:top}
      th{color:var(--muted);text-align:left;font-weight:700}
      .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
      .kpi{background:rgba(2,6,23,.6);border:1px solid var(--border);border-radius:10px;padding:12px}
      .kpi strong{display:block;font-size:18px}
      .pill{display:inline-flex;align-items:center;gap:8px;padding:4px 10px;border-radius:999px;border:1px solid var(--border);font-weight:700;font-size:12px}
      .live{color:var(--good)}
      .right{margin-left:auto}
      .mono{font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace;}
      .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
      .btn{appearance:none;border:1px solid var(--border);background:#0b1220;color:var(--text);padding:8px 10px;border-radius:8px;font-weight:700;cursor:pointer}
      .btn:hover{filter:brightness(1.1)}
      .small{font-size:12px}
      .detail{white-space:pre-wrap;background:rgba(2,6,23,.6);border:1px solid var(--border);border-radius:10px;padding:12px;font-size:12px;min-height:160px}
      .brand{display:flex;align-items:center;gap:12px}
      .brand img{display:block;height:42px;width:auto;max-width:220px;object-fit:contain}
      @media (max-width: 980px){.grid{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(2,1fr)}}
    </style>
  </head>
  <body>
    <header>
      <div class="brand">
        <img src="/logo2.png" alt="CT-e Fácil" />
      </div>
      <div class="row right">
        <span class="pill"><span class="live">●</span><span id="liveCount">0</span> ao vivo</span>
        <button class="btn" id="refreshBtn" type="button">Atualizar</button>
      </div>
    </header>
    <div class="wrap">
      <div class="kpis">
        <div class="kpi"><div class="muted">Sessões</div><strong id="kpiSessions">0</strong></div>
        <div class="kpi"><div class="muted">Leads</div><strong id="kpiLeads">0</strong></div>
        <div class="kpi"><div class="muted">Oferta vista</div><strong id="kpiOffer">0</strong></div>
        <div class="kpi"><div class="muted">Checkout iniciado</div><strong id="kpiCheckout">0</strong></div>
      </div>

      <div class="grid" style="margin-top:14px;">
        <div class="card">
          <h2>Funil</h2>
          <table>
            <thead><tr><th>Etapa</th><th>Total</th><th>Abandono</th></tr></thead>
            <tbody>
              <tr><td>Quiz iniciado</td><td id="fQuizStart">0</td><td id="aQuiz">0</td></tr>
              <tr><td>Quiz passo 2+</td><td id="fQuiz2">0</td><td class="muted">—</td></tr>
              <tr><td>Quiz passo 3+</td><td id="fQuiz3">0</td><td class="muted">—</td></tr>
              <tr><td>Quiz passo 4+</td><td id="fQuiz4">0</td><td class="muted">—</td></tr>
              <tr><td>Quiz passo 5+</td><td id="fQuiz5">0</td><td class="muted">—</td></tr>
              <tr><td>Identificação (Lead)</td><td id="fLead">0</td><td id="aLead">0</td></tr>
              <tr><td>Vídeo</td><td id="fVideo">0</td><td id="aVideo">0</td></tr>
              <tr><td>Oferta vista</td><td id="fOffer">0</td><td id="aOffer">0</td></tr>
              <tr><td>Checkout iniciado</td><td id="fCheckout">0</td><td class="muted">—</td></tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <h2>Ao vivo</h2>
          <table>
            <thead><tr><th>Sessão</th><th>Última view</th><th>Último evento</th><th>Há</th></tr></thead>
            <tbody id="liveTable"></tbody>
          </table>
        </div>
      </div>

      <div class="grid" style="margin-top:14px;">
        <div class="card">
          <h2>Leads</h2>
          <table>
            <thead><tr><th>Nome</th><th>WhatsApp</th><th>CNPJ</th><th>Perfil</th><th>Plano</th><th>Quando</th></tr></thead>
            <tbody id="leadsTable"></tbody>
          </table>
        </div>
        <div class="card">
          <h2>Detalhes</h2>
          <div class="detail mono" id="detailBox">{}</div>
        </div>
      </div>

      <div class="card" style="margin-top:14px;">
        <div class="row">
          <h2 style="margin:0;">Eventos (ao vivo)</h2>
          <span class="muted small">últimos 50</span>
        </div>
        <table>
          <thead><tr><th>Quando</th><th>Sessão</th><th>Evento</th><th>Payload</th></tr></thead>
          <tbody id="eventsTable"></tbody>
        </table>
      </div>
    </div>

    <script>
      function fmtAgo(ms) {
        if (ms < 1000) return "agora";
        var s = Math.floor(ms / 1000);
        if (s < 60) return s + "s";
        var m = Math.floor(s / 60);
        if (m < 60) return m + "m";
        var h = Math.floor(m / 60);
        return h + "h";
      }

      function short(id) {
        return String(id || "").slice(0, 8);
      }

      function setText(id, value) {
        var el = document.getElementById(id);
        if (el) el.textContent = value;
      }

      async function fetchJson(url) {
        var r = await fetch(url, { cache: "no-store" });
        return await r.json();
      }

      function renderStats(data) {
        setText("kpiSessions", data.sessionsTotal || 0);
        setText("kpiLeads", (data.leads || []).length);
        setText("kpiOffer", data.funnel.offer || 0);
        setText("kpiCheckout", data.funnel.checkout || 0);
        setText("liveCount", (data.live || []).length);

        setText("fQuizStart", data.funnel.quizStarted || 0);
        setText("fQuiz2", data.funnel.quizStep2 || 0);
        setText("fQuiz3", data.funnel.quizStep3 || 0);
        setText("fQuiz4", data.funnel.quizStep4 || 0);
        setText("fQuiz5", data.funnel.quizStep5 || 0);
        setText("fLead", data.funnel.lead || 0);
        setText("fVideo", data.funnel.video || 0);
        setText("fOffer", data.funnel.offer || 0);
        setText("fCheckout", data.funnel.checkout || 0);

        setText("aQuiz", data.abandoned.quiz || 0);
        setText("aLead", data.abandoned.lead || 0);
        setText("aVideo", data.abandoned.video || 0);
        setText("aOffer", data.abandoned.offer || 0);

        var liveBody = document.getElementById("liveTable");
        liveBody.innerHTML = "";
        (data.live || []).forEach(function (s) {
          var tr = document.createElement("tr");
          tr.innerHTML =
            "<td class='mono'>" + short(s.sessionId) + "</td>" +
            "<td>" + (s.lastView || "-") + "</td>" +
            "<td>" + (s.lastEvent || "-") + "</td>" +
            "<td>" + fmtAgo(Date.now() - s.lastSeenAt) + "</td>";
          liveBody.appendChild(tr);
        });
      }

      function renderLeads(leads) {
        var tbody = document.getElementById("leadsTable");
        tbody.innerHTML = "";
        leads.forEach(function (l) {
          var tr = document.createElement("tr");
          tr.style.cursor = "pointer";
          tr.innerHTML =
            "<td>" + (l.name || "-") + "</td>" +
            "<td class='mono'>" + (l.whatsapp || "-") + "</td>" +
            "<td class='mono'>" + (l.cnpj || "-") + "</td>" +
            "<td>" + (l.perfil || "-") + "</td>" +
            "<td>" + (l.plan || "-") + "</td>" +
            "<td>" + new Date(l.createdAt).toLocaleString() + "</td>";
          tr.addEventListener("click", function () {
            document.getElementById("detailBox").textContent = JSON.stringify(l, null, 2);
          });
          tbody.appendChild(tr);
        });
      }

      function renderEvents(events) {
        var tbody = document.getElementById("eventsTable");
        tbody.innerHTML = "";
        events.slice(0, 50).forEach(function (e) {
          var tr = document.createElement("tr");
          var payloadText = "";
          try { payloadText = JSON.stringify(e.payload || {}); } catch (_) {}
          if (payloadText.length > 140) payloadText = payloadText.slice(0, 140) + "...";
          tr.innerHTML =
            "<td>" + new Date(e.ts).toLocaleTimeString() + "</td>" +
            "<td class='mono'>" + short(e.sessionId) + "</td>" +
            "<td>" + e.event + "</td>" +
            "<td class='mono'>" + payloadText + "</td>";
          tbody.appendChild(tr);
        });
      }

      async function refreshAll() {
        var data = await fetchJson("/api/stats");
        renderStats(data);
        renderLeads(data.leads || []);
        renderEvents(data.events || []);
      }

      document.getElementById("refreshBtn").addEventListener("click", refreshAll);

      refreshAll();
      setInterval(refreshAll, 3000);

      var es = new EventSource("/api/stream");
      es.addEventListener("track", function () {});
      es.addEventListener("ping", function () {});
    </script>
  </body>
</html>`;

const accessHtml = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CT-e Fácil - Acesso</title>
    <style>
      :root { --bg:#0b1220; --card:#0f172a; --muted:#94a3b8; --text:#e2e8f0; --border:rgba(148,163,184,.18); --brand:#22c55e; }
      body{margin:0;font-family:Arial,Helvetica,sans-serif;background:linear-gradient(180deg,var(--bg),#020617);color:var(--text);min-height:100vh;display:grid;place-items:center;padding:18px}
      .box{width:100%;max-width:420px;background:rgba(15,23,42,.94);border:1px solid var(--border);border-radius:12px;padding:22px;box-sizing:border-box}
      .logo{display:flex;justify-content:center;margin-bottom:18px}
      .logo img{display:block;height:52px;width:auto;max-width:240px;object-fit:contain}
      label{display:block;margin:0 0 8px;font-size:13px;font-weight:700}
      input{width:100%;height:50px;border:1px solid var(--border);border-radius:8px;background:#020617;color:var(--text);padding:0 14px;box-sizing:border-box}
      button{width:100%;height:50px;margin-top:14px;border:0;border-radius:8px;background:var(--brand);color:#fff;font-weight:800;cursor:pointer}
      .error{margin-top:12px;padding:12px 14px;border:1px solid rgba(239,68,68,.4);background:rgba(127,29,29,.25);border-radius:8px;color:#fecaca;font-size:14px}
    </style>
  </head>
  <body>
    <form class="box" method="post" action="/acesso">
      <div class="logo"><img src="/logo2.png" alt="CT-e Fácil" /></div>
      <label for="password">Senha</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button type="submit">ENTRAR</button>
      __ERROR__
    </form>
  </body>
</html>`;

function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write("event: ping\n");
  res.write("data: " + JSON.stringify({ ts: now() }) + "\n\n");
  state.sseClients.add(res);
  req.on("close", () => {
    state.sseClients.delete(res);
  });
}

setInterval(() => {
  for (const client of state.sseClients) {
    try {
      client.write("event: ping\n");
      client.write("data: " + JSON.stringify({ ts: now() }) + "\n\n");
    } catch (_) {}
  }
}, 10_000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const ip = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : null;
  const ua = req.headers["user-agent"] ? String(req.headers["user-agent"]) : null;
  const reqMeta = { ip, ua };

  if (req.method === "GET" && url.pathname === "/") {
    return serveFile(res, path.join(__dirname, "index.html"));
  }
  if (req.method === "GET" && url.pathname === "/logo.png") {
    return serveFile(res, path.join(__dirname, "logo.png"));
  }
  if (req.method === "GET" && url.pathname === "/logo2.png") {
    return serveFile(res, path.join(__dirname, "logo2.png"));
  }
  if (req.method === "GET" && url.pathname === "/acesso") {
    if (!isAdminAuthorized(req)) {
      return text(res, 200, accessHtml.replace("__ERROR__", ""), "text/html");
    }
    return text(res, 200, adminHtml, "text/html");
  }
  if (req.method === "POST" && url.pathname === "/acesso") {
    const body = await readBody(req);
    const form = parseFormUrlEncoded(body);
    if (String(form.password || "") !== ADMIN_PASSWORD) {
      return text(
        res,
        401,
        accessHtml.replace("__ERROR__", '<div class="error">Senha incorreta.</div>'),
        "text/html"
      );
    }
    res.writeHead(302, {
      Location: "/acesso",
      "Set-Cookie": ADMIN_COOKIE + "=" + ADMIN_COOKIE_VALUE + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400",
    });
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/api/stream") {
    if (!isAdminAuthorized(req)) return json(res, 401, { ok: false });
    return handleSse(req, res);
  }

  if (req.method === "POST" && url.pathname === "/api/track") {
    const body = await readBody(req);
    const data = safeJsonParse(body);
    if (!data || typeof data !== "object") {
      return json(res, 400, { ok: false });
    }
    const e = recordEvent(data, reqMeta);
    if (!e) return json(res, 400, { ok: false });
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/stats") {
    if (!isAdminAuthorized(req)) return json(res, 401, { ok: false });
    const base = getFunnelStats();
    const live = getLiveSessions();
    const leads = Array.from(state.leads.values())
      .map((l) => {
        const s = state.sessions.get(l.sessionId);
        const plan = s && s.selectedPlanKey ? s.selectedPlanKey : null;
        return { ...l, plan };
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 500);
    const events = state.events.slice(-50).reverse();
    return json(res, 200, { ...base, live, leads, events });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/")) {
    return json(res, 404, { ok: false });
  }

  const requested = url.pathname.replace(/^\/+/, "");
  if (requested && /^[a-zA-Z0-9._/-]+$/.test(requested)) {
    return serveFile(res, path.join(__dirname, requested));
  }

  text(res, 404, "Not found");
});

server.listen(PORT, HOST, () => {
  process.stdout.write("Admin: http://localhost:" + PORT + "/acesso\n");
  process.stdout.write("Site:  http://localhost:" + PORT + "/\n");
});
