// Transmissor de Tela - servidor (sem dependências)
// Uso: node server.js [porta] [--internet]
//   --internet  cria um link público (via túnel SSH do localhost.run) para quem está fora da sua rede
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

// clientes conectados via Server-Sent Events: id -> { role, res, relay }
const clients = new Map();
let senderId = null;
let senderName = '';
// hospedado na internet (Render define RENDER e RENDER_EXTERNAL_URL)
const HOSTED = !!(process.env.RENDER || process.env.HOSTED);
let publicUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || null;

// ---------- servidores ICE (STUN + ponte TURN) ----------
// Com a ponte TURN o vídeo passa mesmo quando a conexão direta é bloqueada (4G, roteadores).
// Cloudflare: defina CF_TURN_KEY_ID e CF_TURN_API_TOKEN (painel da Cloudflare > Realtime > TURN).
// Outro provedor: TURN_URLS (separadas por vírgula), TURN_USERNAME e TURN_CREDENTIAL.
const STUN = { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] };
let iceCache = null, iceCacheAt = 0;
async function getIceServers() {
  if (iceCache && Date.now() - iceCacheAt < 6 * 3600e3) return iceCache;
  const servers = [STUN];
  const { CF_TURN_KEY_ID: keyId, CF_TURN_API_TOKEN: token } = process.env;
  try {
    if (keyId && token) {
      const base = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials`;
      const opts = { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }) };
      let r = await fetch(`${base}/generate-ice-servers`, opts);
      if (r.status === 404) r = await fetch(`${base}/generate`, opts);
      if (!r.ok) throw new Error(`Cloudflare respondeu ${r.status}`);
      const j = await r.json();
      const list = Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers];
      servers.push(...list.filter((s) => s && s.username));
    } else if (process.env.TURN_URLS) {
      servers.push({ urls: process.env.TURN_URLS.split(',').map((s) => s.trim()), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
    }
  } catch (e) {
    log('Não consegui pegar a ponte TURN: ' + e.message);
    return servers; // tenta de novo no próximo pedido
  }
  iceCache = servers; iceCacheAt = Date.now();
  return servers;
}

// modo reserva: último quadro JPEG enviado pelo transmissor
let frame = null, frameSeq = 0, lastClientFrame = 0;
let frameWaiters = [];

function send(id, msg) {
  const c = clients.get(id);
  if (c) c.res.write(`data: ${JSON.stringify(msg)}\n\n`);
}

function viewerIds() {
  return [...clients.entries()].filter(([, c]) => c.role === 'viewer').map(([id]) => id);
}

function broadcastStatus() {
  for (const id of viewerIds()) send(id, { type: 'status', live: !!senderId, name: senderName });
  if (senderId) {
    const ids = viewerIds();
    send(senderId, { type: 'viewers', count: ids.length, relay: ids.filter((id) => clients.get(id).relay).length });
  }
}

function serveFile(res, file, type) {
  fs.readFile(path.join(PUBLIC, file), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Não encontrado'); }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); reject(new Error('grande demais')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // pedido feito no próprio PC (e não vindo pelo túnel público)
  const isLocal = !HOSTED && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    && !req.headers['x-forwarded-for']
    && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '');

  // uma página só para assistir e compartilhar (os endereços antigos abrem a mesma)
  if (req.method === 'GET' && ['/', '/assistir', '/transmitir'].includes(url.pathname)) return serveFile(res, 'index.html', 'text/html; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/style.css') return serveFile(res, 'style.css', 'text/css; charset=utf-8');

  if (req.method === 'GET' && url.pathname === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      port: PORT, ips: HOSTED ? [] : localIps(), live: !!senderId, presenter: senderName, internet: INTERNET || HOSTED, publicUrl,
      isHost: isLocal,
    }));
  }

  // canal de eventos (servidor -> navegador)
  if (req.method === 'GET' && url.pathname === '/events') {
    const role = url.searchParams.get('role') === 'sender' ? 'sender' : 'viewer';
    const id = crypto.randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`: ${' '.repeat(2048)}\n\n`); // evita que proxies segurem o fluxo

    // um por vez: quem chega espera o atual parar (só o anfitrião, no próprio PC, pode assumir)
    if (role === 'sender' && senderId && clients.has(senderId) && !isLocal) {
      const reason = `${senderName} já está apresentando. Espere terminar para compartilhar a sua tela.`;
      res.write(`data: ${JSON.stringify({ type: 'denied', reason })}\n\n`);
      return res.end();
    }

    res.write(`data: ${JSON.stringify({ type: 'hello', id, role })}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    clients.set(id, { role, res, relay: false });

    if (role === 'sender') {
      const name = (url.searchParams.get('name') || '').trim().slice(0, 30) || 'Alguém';
      if (senderId) send(senderId, { type: 'replaced', by: name }); // um apresentador por vez
      senderId = id;
      senderName = name;
      frame = null; lastClientFrame = 0;
      for (const v of viewerIds()) send(senderId, { type: 'viewer-joined', id: v });
      log(`${name} começou a apresentar (${viewerIds().length} espectador(es))`);
    } else {
      if (senderId) send(senderId, { type: 'viewer-joined', id });
      log(`Espectador entrou (${viewerIds().length} no total)`);
    }
    broadcastStatus();

    req.on('close', () => {
      clearInterval(ping);
      clients.delete(id);
      if (id === senderId) {
        senderId = null;
        senderName = '';
        frame = null;
        for (const v of viewerIds()) send(v, { type: 'sender-left' });
        log('Apresentação encerrada');
      } else if (role === 'viewer') {
        if (senderId) send(senderId, { type: 'viewer-left', id });
        log(`Espectador saiu (${viewerIds().length} no total)`);
      }
      broadcastStatus();
    });
    return;
  }

  // mensagens de sinalização WebRTC (navegador -> servidor -> outro navegador)
  if (req.method === 'POST' && url.pathname === '/signal') {
    try {
      const { from, to, data } = JSON.parse(await readBody(req));
      if (!clients.has(from)) { res.writeHead(403); return res.end(); }
      const target = to === 'sender' ? senderId : to;
      if (target && clients.has(target)) send(target, { type: 'signal', from, data });
      res.writeHead(204); return res.end();
    } catch {
      res.writeHead(400); return res.end();
    }
  }

  // espectador avisa que a conexão direta falhou e vai usar o modo reserva
  if (req.method === 'POST' && url.pathname === '/relay') {
    try {
      const { id } = JSON.parse(await readBody(req));
      const c = clients.get(id);
      if (c && c.role === 'viewer' && !c.relay) { c.relay = true; log('Espectador usando modo reserva'); broadcastStatus(); }
      res.writeHead(204); return res.end();
    } catch {
      res.writeHead(400); return res.end();
    }
  }

  // transmissor envia um quadro (modo reserva)
  if (req.method === 'POST' && url.pathname === '/frame') {
    if (!senderId || req.headers['x-id'] !== senderId) { res.writeHead(403); return res.end(); }
    try {
      const body = await readBody(req, 5e6);
      // vários quadros podem estar a caminho ao mesmo tempo: descarta o que chegar atrasado
      const n = Number(req.headers['x-frame'] || 0);
      if (n && n <= lastClientFrame) { res.writeHead(204); return res.end(); }
      lastClientFrame = n;
      frame = body;
      frameSeq++;
      const waiters = frameWaiters; frameWaiters = [];
      for (const w of waiters) sendFrame(w);
      res.writeHead(204); return res.end();
    } catch {
      res.writeHead(400); return res.end();
    }
  }

  // configuração de conexão (STUN + ponte TURN com credenciais temporárias)
  if (req.method === 'GET' && url.pathname === '/ice') {
    const iceServers = await getIceServers();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ iceServers, turn: iceServers.length > 1 }));
  }

  // espectador pede o próximo quadro (espera até chegar um novo)
  if (req.method === 'GET' && url.pathname === '/frame') {
    const after = Number(url.searchParams.get('after') || 0);
    if (frame && frameSeq > after) return sendFrame(res);
    const timer = setTimeout(() => {
      frameWaiters = frameWaiters.filter((w) => w !== res);
      res.writeHead(204); res.end();
    }, 10000);
    res.on('close', () => { clearTimeout(timer); frameWaiters = frameWaiters.filter((w) => w !== res); });
    res._timer = timer;
    frameWaiters.push(res);
    return;
  }

  res.writeHead(404); res.end('Não encontrado');
});

function sendFrame(res) {
  clearTimeout(res._timer);
  if (res.writableEnded) return;
  if (!frame) { res.writeHead(204); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Seq': String(frameSeq) });
  res.end(frame);
}

function localIps() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254'))
    .map((i) => i.address);
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${msg}`);
}

// ---------- link público (túnel SSH via localhost.run) ----------
let tunnel = null;
function startTunnel() {
  log('Criando link público…');
  tunnel = spawn('ssh', [
    '-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes',
    '-R', `80:127.0.0.1:${PORT}`, 'nokey@localhost.run',
  ], { windowsHide: true });
  const onData = (d) => {
    const m = String(d).match(/https:\/\/[a-z0-9.-]+\.lhr\.life/i);
    if (m && m[0] !== publicUrl) {
      publicUrl = m[0];
      console.log(`\n  >>> LINK PÚBLICO (assistir e compartilhar): ${publicUrl}/\n`);
    }
  };
  tunnel.stdout.on('data', onData);
  tunnel.stderr.on('data', onData);
  tunnel.on('error', () => log('Não encontrei o "ssh". No Windows 10/11 ele vem em Recursos Opcionais > Cliente OpenSSH.'));
  tunnel.on('exit', () => {
    publicUrl = null;
    tunnel = null;
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
  if (HOSTED) {
    console.log(`Transmissor de Tela no ar (modo hospedado) na porta ${PORT}. Link: ${publicUrl || '(defina PUBLIC_URL)'}`);
    return;
  }
  console.log('\n  Transmissor de Tela rodando!\n');
  console.log(`  Abra neste PC:  http://localhost:${PORT}/`);
  for (const ip of localIps()) console.log(`  Na mesma rede: http://${ip}:${PORT}/`);
  console.log('\n  Ctrl+C para parar.\n');
  if (INTERNET) startTunnel();
});
