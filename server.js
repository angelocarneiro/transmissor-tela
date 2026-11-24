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

// ---------- salas ----------
// sala: { code, hostId, members: Map(id -> { id, name, res, sharing }), frames: Map(sharerId -> quadro), emptySince }
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
  const members = [...room.members.values()].map((m) => ({ id: m.id, name: m.name, sharing: m.sharing }));
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
      return json(res, 200, { ok: true, publicUrl, internet: INTERNET || HOSTED, rooms: rooms.size });
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
      const name = cleanName(url.searchParams.get('name'));
      room.members.set(id, { id, name, res, sharing: false });
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
