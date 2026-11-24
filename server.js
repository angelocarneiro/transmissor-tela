// KOMAND Live - servidor de salas para transmitir a tela (sem dependências)
// Uso: node server.js [porta] [--internet]
//   --internet  cria um link público temporário (via túnel SSH do localhost.run)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const PORT = Number(process.env.PORT || args.find((a) => /^\d+$/.test(a)) || 3030);
const INTERNET = args.includes('--internet');
const PUBLIC = path.join(__dirname, 'public');
const HOSTED = !!(process.env.RENDER || process.env.HOSTED);
let publicUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || null;

// ---------- servidores ICE (STUN + ponte TURN) ----------
// Cloudflare: CF_TURN_KEY_ID e CF_TURN_API_TOKEN (painel da Cloudflare > Realtime > TURN Server).
// Outro provedor: TURN_URLS (separadas por vírgula), TURN_USERNAME e TURN_CREDENTIAL.
const STUN = { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] };
let iceCache = null, iceCacheAt = 0;
async function getIceServers() {
  if (iceCache && Date.now() - iceCacheAt < 6 * 3600e3) return iceCache;
  const servers = [STUN];
  const clean = (v) => String(v || '').replace(/[\s"']/g, '');
  const keyId = clean(process.env.CF_TURN_KEY_ID), token = clean(process.env.CF_TURN_API_TOKEN);
  try {
    if (keyId && token) {
      const base = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials`;
      const opts = { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }) };
      let r = await fetch(`${base}/generate-ice-servers`, opts);
      if (r.status === 404) r = await fetch(`${base}/generate`, opts);
      if (!r.ok) {
        const detail = (await r.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
        throw new Error(`Cloudflare respondeu ${r.status} (${detail || 'sem detalhe'}). `
          + `CF_TURN_KEY_ID tem ${keyId.length} caracteres, CF_TURN_API_TOKEN tem ${token.length}.`);
      }
      const j = await r.json();
      const list = Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers];
      servers.push(...list.filter((s) => s && s.username));
    } else if (process.env.TURN_URLS) {
      servers.push({ urls: process.env.TURN_URLS.split(',').map((s) => s.trim()), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
    }
  } catch (e) {
    log('Não consegui pegar a ponte TURN: ' + e.message);
    return servers;
  }
  iceCache = servers; iceCacheAt = Date.now();
  return servers;
}

// ---------- login com Discord (só quem tem o cargo KOMAND Live no servidor entra) ----------
// Variáveis no Render: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_GUILD_ID (ID do servidor),
// DISCORD_ROLE_ID (ID do cargo) e SESSION_SECRET (texto aleatório que protege o login).
const cleanEnv = (v) => String(v || '').replace(/[\s"']/g, '');
const DISCORD = {
  clientId: cleanEnv(process.env.DISCORD_CLIENT_ID),
  secret: cleanEnv(process.env.DISCORD_CLIENT_SECRET),
  guild: cleanEnv(process.env.DISCORD_GUILD_ID),
  role: cleanEnv(process.env.DISCORD_ROLE_ID),
};
const SESSION_SECRET = String(process.env.SESSION_SECRET || '').trim() || (HOSTED ? '' : 'segredo-local-de-teste');
const AUTH_READY = !!(DISCORD.clientId && DISCORD.secret && DISCORD.guild && DISCORD.role && SESSION_SECRET);
// Login de teste, só no PC (nunca no Render): DEV_LOGIN=1 libera /auth/dev?name=Fulano
const DEV_LOGIN = !HOSTED && process.env.DEV_LOGIN === '1';
const SESSION_DAYS = 30; // fica conectado por 30 dias (a autorização do Discord é renovada sozinha)

// a sessão vai num cookie criptografado (AES-256-GCM): ninguém consegue ler nem forjar
const SESSION_KEY = crypto.createHash('sha256').update('komand-live:' + SESSION_SECRET).digest();
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SESSION_KEY, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64url');
}
function unseal(s) {
  try {
    const b = Buffer.from(String(s || ''), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', SESSION_KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]));
  } catch { return null; }
}
function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookie(name, value, maxAgeSec) {
  const secure = HOSTED ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}
function siteOrigin(req) {
  if (publicUrl) return publicUrl.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${req.headers.host}`;
}
function redirect(res, location, cookies = []) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
  res.end();
}
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[\w\-/]*$/.test(n) ? n : '/');

// pergunta ao Discord se a pessoa está no servidor e tem o cargo
async function discordMember(token) {
  const r = await fetch(`https://discord.com/api/v10/users/@me/guilds/${DISCORD.guild}/member`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return { status: 'fora-do-servidor' };
  if (r.status === 401) return { status: 'expirou' };
  if (!r.ok) throw new Error(`Discord respondeu ${r.status}`);
  const m = await r.json();
  return { status: (m.roles || []).includes(DISCORD.role) ? 'ok' : 'sem-cargo', member: m };
}
function avatarUrl(m) {
  const u = m.user || {};
  if (m.avatar) return `https://cdn.discordapp.com/guilds/${DISCORD.guild}/users/${u.id}/avatars/${m.avatar}.png?size=64`;
  if (u.avatar) return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`;
  return null;
}

// renovação da autorização do Discord (dura 7 dias; com o "refresh token" vira 30 dias de sessão)
const tokenStore = new Map();  // uid -> tokens mais novos { tok, rt, tokExp } (evita usar um código já trocado)
const refreshing = new Map();  // uid -> renovação em andamento (duas abas ao mesmo tempo não brigam)
class RefreshRejected extends Error {}
function refreshTokens(uid, rt) {
  if (refreshing.has(uid)) return refreshing.get(uid);
  const job = (async () => {
    const r = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: DISCORD.clientId, client_secret: DISCORD.secret, grant_type: 'refresh_token', refresh_token: rt }),
    });
    if (r.status === 400 || r.status === 401) throw new RefreshRejected('autorização removida ou vencida');
    if (!r.ok) throw new Error('Discord respondeu ' + r.status);
    const t = await r.json();
    const v = { tok: t.access_token, rt: t.refresh_token, tokExp: Date.now() + (Number(t.expires_in) || 604800) * 1000 };
    tokenStore.set(uid, v);
    return v;
  })();
  refreshing.set(uid, job);
  job.finally(() => refreshing.delete(uid)).catch(() => {});
  return job;
}

// quem está logado? (confere de novo no Discord a cada 5 minutos: tirou o cargo, perdeu o acesso)
const memberCheck = new Map(); // uid -> { ok, at }
async function currentUser(req, res) {
  if (!AUTH_READY && !DEV_LOGIN) return null;
  const s = unseal(readCookies(req).komand_sess);
  if (!s || !s.uid || s.exp < Date.now()) return null;
  if (s.dev) return DEV_LOGIN ? s : null;
  let updated = false;
  const known = tokenStore.get(s.uid);
  if (known && known.tokExp > (s.tokExp || 0)) { Object.assign(s, known); updated = true; }
  const saveCookie = () => {
    if (updated && res && !res.headersSent) res.setHeader('Set-Cookie', cookie('komand_sess', seal(s), Math.max(1, Math.floor((s.exp - Date.now()) / 1000))));
  };
  const cached = memberCheck.get(s.uid);
  if (cached && Date.now() - cached.at < 5 * 60e3) { saveCookie(); return cached.ok ? s : null; }
  try {
    // autorização perto de vencer: renova antes de perguntar ao Discord
    if (s.rt && (s.tokExp || 0) < Date.now() + 24 * 3600e3) { Object.assign(s, await refreshTokens(s.uid, s.rt)); updated = true; }
    let r = await discordMember(s.tok);
    if (r.status === 'expirou' && s.rt) { Object.assign(s, await refreshTokens(s.uid, s.rt)); updated = true; r = await discordMember(s.tok); }
    memberCheck.set(s.uid, { ok: r.status === 'ok', at: Date.now() });
    saveCookie();
    return r.status === 'ok' ? s : null;
  } catch (e) {
    if (e instanceof RefreshRejected) { memberCheck.set(s.uid, { ok: false, at: Date.now() }); return null; } // removeu a autorização no Discord
    log('Não consegui conferir no Discord: ' + e.message);
    saveCookie();
    return s; // Discord instável: mantém quem já estava logado
  }
}

// ---------- salas ----------
// sala: { code, hostId, members: Map(id -> { id, name, avatar, res, sharing }), frames: Map(sharerId -> quadro), emptySince }
const rooms = new Map();
const MAX_ROOMS = 500, MAX_MEMBERS = 50;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O e 1/I, que confundem

function newCode() {
  let code;
  do {
    let s = '';
    for (let i = 0; i < 8; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    code = s.slice(0, 4) + '-' + s.slice(4);
  } while (rooms.has(code));
  return code;
}
function normCode(c) {
  const s = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4) : null;
}
function cleanName(n) {
  return String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || 'Convidado';
}

function send(room, id, msg) {
  const m = room.members.get(id);
  if (m) m.res.write(`data: ${JSON.stringify(msg)}\n\n`);
}
function broadcast(room, msg) {
  for (const id of room.members.keys()) send(room, id, msg);
}
function pushMembers(room) {
  const members = [...room.members.values()].map((m) => ({ id: m.id, name: m.name, avatar: m.avatar, sharing: m.sharing }));
  broadcast(room, { type: 'members', members, hostId: room.hostId });
}

// salas vazias somem depois de 30 minutos
setInterval(() => {
  const limit = Date.now() - 30 * 60e3;
  for (const [code, room] of rooms) if (!room.members.size && room.emptySince < limit) rooms.delete(code);
}, 60e3).unref();

// ---------- utilidades HTTP ----------
function serveFile(res, file, type) {
  fs.readFile(path.join(PUBLIC, file), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Não encontrado'); }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); reject(new Error('grande demais')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  return JSON.parse(String(await readBody(req)) || '{}');
}
// confere se quem mandou está mesmo na sala
function memberOf(body) {
  const room = rooms.get(normCode(body.room));
  const me = room && room.members.get(body.from);
  return me ? { room, me } : null;
}

const REACTIONS = new Set(['like', 'heart', 'fire']);

// Se REDIRECT_TO estiver definido, este servidor só manda as pessoas para o endereço novo
// (usado no link antigo, para os links já compartilhados continuarem funcionando).
const REDIRECT_TO = String(process.env.REDIRECT_TO || '').trim().replace(/\/+$/, '');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (REDIRECT_TO && p !== '/info') {
    res.writeHead(301, { Location: REDIRECT_TO + req.url, 'Cache-Control': 'no-store' });
    return res.end();
  }

  try {
    // páginas
    if (req.method === 'GET' && (p === '/' || p === '/assistir' || p === '/transmitir' || /^\/sala\/[A-Za-z0-9-]+\/?$/.test(p))) {
      return serveFile(res, 'index.html', 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/style.css') return serveFile(res, 'style.css', 'text/css; charset=utf-8');
    // imagens da pasta public (só o nome do arquivo, sem subpastas)
    const imgMatch = p.match(/^\/([a-z0-9-]+\.(png|jpg|svg|webp))$/i);
    if (req.method === 'GET' && imgMatch) {
      const types = { png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp' };
      return fs.readFile(path.join(PUBLIC, imgMatch[1]), (err, data) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': types[imgMatch[2].toLowerCase()], 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
      });
    }

    if (req.method === 'GET' && p === '/info') {
      // MAX_VIEWERS: quantas pessoas podem assistir cada apresentador (protege a qualidade e o uso da ponte TURN)
      return json(res, 200, { ok: true, publicUrl, internet: INTERNET || HOSTED, rooms: rooms.size, maxViewers: Number(process.env.MAX_VIEWERS) || 10 });
    }

    // ----- login com Discord -----
    if (req.method === 'GET' && p === '/auth/discord') {
      if (!AUTH_READY) return redirect(res, '/?erro=nao-configurado');
      const state = crypto.randomBytes(16).toString('hex');
      const next = safeNext(url.searchParams.get('next'));
      const q = new URLSearchParams({
        client_id: DISCORD.clientId, response_type: 'code', scope: 'identify guilds.members.read',
        redirect_uri: siteOrigin(req) + '/auth/discord/callback', state, prompt: 'none',
      });
      return redirect(res, 'https://discord.com/oauth2/authorize?' + q, [cookie('komand_oauth', seal({ state, next, exp: Date.now() + 10 * 60e3 }), 600)]);
    }
    if (req.method === 'GET' && p === '/auth/discord/callback') {
      const o = unseal(readCookies(req).komand_oauth);
      const clear = cookie('komand_oauth', '', 0);
      if (!AUTH_READY || !o || o.exp < Date.now() || o.state !== url.searchParams.get('state')) return redirect(res, '/?erro=falhou', [clear]);
      if (url.searchParams.get('error') || !url.searchParams.get('code')) return redirect(res, '/?erro=cancelado', [clear]);
      try {
        const tr = await fetch('https://discord.com/api/v10/oauth2/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: DISCORD.clientId, client_secret: DISCORD.secret, grant_type: 'authorization_code',
            code: url.searchParams.get('code'), redirect_uri: siteOrigin(req) + '/auth/discord/callback',
          }),
        });
        if (!tr.ok) throw new Error('token ' + tr.status);
        const t = await tr.json();
        const r = await discordMember(t.access_token);
        if (r.status !== 'ok') { log(`Login recusado (${r.status})`); return redirect(res, '/?erro=' + r.status, [clear]); }
        const m = r.member, u = m.user;
        const maxAge = SESSION_DAYS * 86400;
        const sess = {
          uid: u.id, name: cleanName(m.nick || u.global_name || u.username), avatar: avatarUrl(m),
          tok: t.access_token, rt: t.refresh_token, tokExp: Date.now() + (Number(t.expires_in) || 604800) * 1000,
          exp: Date.now() + maxAge * 1000,
        };
        tokenStore.set(u.id, { tok: sess.tok, rt: sess.rt, tokExp: sess.tokExp });
        memberCheck.set(u.id, { ok: true, at: Date.now() });
        log(`${sess.name} entrou com Discord`);
        return redirect(res, o.next || '/', [clear, cookie('komand_sess', seal(sess), maxAge)]);
      } catch (e) {
        log('Falha no login com Discord: ' + e.message);
        return redirect(res, '/?erro=falhou', [clear]);
      }
    }
    if (req.method === 'GET' && p === '/auth/logout') return redirect(res, '/', [cookie('komand_sess', '', 0)]);
    if (req.method === 'GET' && p === '/auth/dev' && DEV_LOGIN) { // só para testes no PC
      const sess = { uid: 'dev-' + crypto.randomBytes(4).toString('hex'), name: cleanName(url.searchParams.get('name')), avatar: null, dev: true, exp: Date.now() + 86400e3 };
      return redirect(res, safeNext(url.searchParams.get('next')), [cookie('komand_sess', seal(sess), 86400)]);
    }

    // ----- daqui para baixo, só quem fez login (e tem o cargo) -----
    const user = await currentUser(req, res);
    if (req.method === 'GET' && p === '/api/me') {
      if (!user) return json(res, 401, { login: AUTH_READY || DEV_LOGIN });
      return json(res, 200, { name: user.name, avatar: user.avatar });
    }
    if (!user) {
      if (p === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        res.write(`data: ${JSON.stringify({ type: 'error', reason: 'Seu acesso expirou ou foi removido. Entre com o Discord de novo.', login: true })}\n\n`);
        return res.end();
      }
      return json(res, 401, { error: 'login' });
    }

    if (req.method === 'GET' && p === '/ice') {
      const iceServers = await getIceServers();
      return json(res, 200, { iceServers, turn: iceServers.length > 1 });
    }

    // criar sala
    if (req.method === 'POST' && p === '/api/rooms') {
      if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'Muitas salas abertas agora. Tente de novo em alguns minutos.' });
      const code = newCode();
      rooms.set(code, { code, hostId: null, members: new Map(), frames: new Map(), emptySince: Date.now() });
      log(`Sala ${code} criada`);
      return json(res, 200, { code });
    }
    // conferir se a sala existe
    const m = p.match(/^\/api\/rooms\/([A-Za-z0-9-]+)$/);
    if (req.method === 'GET' && m) {
      const room = rooms.get(normCode(m[1]));
      if (!room) return json(res, 404, { exists: false });
      return json(res, 200, { exists: true, count: room.members.size, sharing: [...room.members.values()].filter((x) => x.sharing).length });
    }

    // canal de eventos da sala (servidor -> navegador)
    if (req.method === 'GET' && p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`: ${' '.repeat(2048)}\n\n`); // evita que proxies segurem o fluxo
      const room = rooms.get(normCode(url.searchParams.get('room')));
      const fail = (reason) => { res.write(`data: ${JSON.stringify({ type: 'error', reason })}\n\n`); res.end(); };
      if (!room) return fail('Essa sala não existe mais. Crie uma nova ou confira o código.');
      if (room.members.size >= MAX_MEMBERS) return fail('A sala está cheia.');

      const id = crypto.randomUUID();
      const name = user.name; // nome vem do Discord (não dá para se passar por outra pessoa)
      room.members.set(id, { id, name, avatar: user.avatar || null, res, sharing: false });
      if (!room.hostId || !room.members.has(room.hostId)) room.hostId = id;
      res.write(`data: ${JSON.stringify({ type: 'hello', id, code: room.code })}\n\n`);
      pushMembers(room);
      log(`${name} entrou na sala ${room.code} (${room.members.size})`);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);

      req.on('close', () => {
        clearInterval(ping);
        const me = room.members.get(id);
        room.members.delete(id);
        room.frames.delete(id);
        if (me && me.sharing) broadcast(room, { type: 'share-ended', id });
        if (room.hostId === id) room.hostId = room.members.keys().next().value || null;
        if (!room.members.size) room.emptySince = Date.now();
        pushMembers(room);
        log(`${name} saiu da sala ${room.code} (${room.members.size})`);
      });
      return;
    }

    // sinalização WebRTC entre duas pessoas da mesma sala
    if (req.method === 'POST' && p === '/signal') {
      const body = await readJson(req);
      const ctx = memberOf(body);
      if (!ctx) return json(res, 403, { error: 'fora da sala' });
      if (ctx.room.members.has(body.to)) send(ctx.room, body.to, { type: 'signal', from: body.from, data: body.data });
      res.writeHead(204); return res.end();
    }

    // começar / parar de transmitir
    if (req.method === 'POST' && p === '/share') {
      const body = await readJson(req);
      const ctx = memberOf(body);
      if (!ctx) return json(res, 403, { error: 'fora da sala' });
      const on = !!body.on;
      if (ctx.me.sharing !== on) {
        ctx.me.sharing = on;
        if (!on) { ctx.room.frames.delete(ctx.me.id); broadcast(ctx.room, { type: 'share-ended', id: ctx.me.id }); }
        pushMembers(ctx.room);
        log(`${ctx.me.name} ${on ? 'começou' : 'parou'} de transmitir na sala ${ctx.room.code}`);
      }
      res.writeHead(204); return res.end();
    }

    // reações (curtir, coração, fogo)
    if (req.method === 'POST' && p === '/react') {
      const body = await readJson(req);
      const ctx = memberOf(body);
      if (!ctx || !REACTIONS.has(body.kind)) return json(res, 400, { error: 'reação inválida' });
      const now = Date.now();
      if (now - (ctx.me.lastReact || 0) > 300) {
        ctx.me.lastReact = now;
        broadcast(ctx.room, { type: 'react', from: ctx.me.id, name: ctx.me.name, kind: body.kind });
      }
      res.writeHead(204); return res.end();
    }

    // modo reserva: quem transmite manda quadros JPEG...
    if (req.method === 'POST' && p === '/frame') {
      const ctx = memberOf({ room: url.searchParams.get('room'), from: req.headers['x-id'] });
      if (!ctx || !ctx.me.sharing) { res.writeHead(403); return res.end(); }
      const buf = await readBody(req, 5e6);
      const f = ctx.room.frames.get(ctx.me.id) || { buf: null, seq: 0, last: 0, waiters: [] };
      ctx.room.frames.set(ctx.me.id, f);
      const n = Number(req.headers['x-frame'] || 0);
      if (!n || n > f.last) {
        f.last = n; f.buf = buf; f.seq++;
        const waiters = f.waiters; f.waiters = [];
        for (const w of waiters) sendFrame(w, f);
      }
      res.writeHead(204); return res.end();
    }
    // ...e quem assiste busca o próximo (espera até chegar um novo)
    if (req.method === 'GET' && p === '/frame') {
      const room = rooms.get(normCode(url.searchParams.get('room')));
      const f = room && room.frames.get(url.searchParams.get('sharer'));
      const after = Number(url.searchParams.get('after') || 0);
      if (!f) { res.writeHead(204); return res.end(); }
      if (f.buf && f.seq > after) return sendFrame(res, f);
      res._timer = setTimeout(() => { f.waiters = f.waiters.filter((w) => w !== res); res.writeHead(204); res.end(); }, 10000);
      res.on('close', () => { clearTimeout(res._timer); f.waiters = f.waiters.filter((w) => w !== res); });
      f.waiters.push(res);
      return;
    }

    res.writeHead(404); res.end('Não encontrado');
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: 'pedido inválido' });
    else res.end();
  }
});

function sendFrame(res, f) {
  clearTimeout(res._timer);
  if (res.writableEnded) return;
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Seq': String(f.seq) });
  res.end(f.buf);
}

function localIps() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254'))
    .map((i) => i.address);
}
function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${msg}`);
}

// ---------- link público temporário (túnel SSH via localhost.run) ----------
let tunnel = null;
function startTunnel() {
  log('Criando link público…');
  tunnel = spawn('ssh', [
    '-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes',
    '-R', `80:127.0.0.1:${PORT}`, 'nokey@localhost.run',
  ], { windowsHide: true });
  const onData = (d) => {
    const found = String(d).match(/https:\/\/[a-z0-9.-]+\.lhr\.life/i);
    if (found && found[0] !== publicUrl) {
      publicUrl = found[0];
      console.log(`\n  >>> LINK PÚBLICO: ${publicUrl}/\n`);
    }
  };
  tunnel.stdout.on('data', onData);
  tunnel.stderr.on('data', onData);
  tunnel.on('error', () => log('Não encontrei o "ssh". No Windows 10/11 ele vem em Recursos Opcionais > Cliente OpenSSH.'));
  tunnel.on('exit', () => {
    publicUrl = null; tunnel = null;
    log('Link público caiu. Reconectando em 5 segundos…');
    setTimeout(startTunnel, 5000);
  });
}
const cleanup = () => { if (tunnel) { tunnel.removeAllListeners('exit'); tunnel.kill(); } process.exit(); };
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\n  A porta ${PORT} já está em uso. Feche o outro programa ou use outra porta: node server.js 3040\n`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  if (HOSTED) return console.log(`KOMAND Live no ar (modo hospedado) na porta ${PORT}. Link: ${publicUrl || '(defina PUBLIC_URL)'}`);
  console.log('\n  KOMAND Live rodando!\n');
  console.log(`  Abra neste PC:  http://localhost:${PORT}/`);
  for (const ip of localIps()) console.log(`  Na mesma rede: http://${ip}:${PORT}/`);
  console.log('\n  Ctrl+C para parar.\n');
  if (INTERNET) startTunnel();
});
