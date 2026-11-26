// Isekai: uma sala só, a dos amigos. Quem entra primeiro segura a sala (o dono) e todo mundo se conecta a ele
// para saber quem está na sala e quem está transmitindo; se o dono sair, outro assume sozinho.
// O vídeo vai direto de quem transmite para quem escolheu assistir.
//
// Segurança: a sala é protegida por uma senha que só os amigos sabem. O endereço da sala no servidor sai da senha
// (quem não sabe a senha nem acha a sala) e, ao conectar, dono e convidado provam um para o outro que sabem a
// senha sem nunca mandar ela pela internet. Quem não prova é desconectado e não vê nem a lista nem o vídeo.
const ROOM_PREFIX = 'isekai-';
const MIN_PASSWORD = 8;
const AUTH_TIMEOUT = 15000;
let ROOM = null;
let authKey = null;
let derivedFor = null;
// 720p é o padrão (leve para qualquer PC e internet); quem quiser escolhe 1080p na hora de compartilhar.
const QUALITIES = {
  '720': { width: 1280, height: 720, bitrate: 5_000_000 },
  '1080': { width: 1920, height: 1080, bitrate: 10_000_000 },
};
let quality = QUALITIES['720'];
const AUDIO_BITRATE = 256_000;
const CONNECT_TIMEOUT = 20000;
// No site (celular ou navegador) dá para assistir; transmitir só no programa de Windows.
const CAN_SHARE = typeof window.isekai.getSources === 'function';
const PEER_OPTIONS = {
  debug: 1,
  secure: true,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
  },
};

async function peerOptions() {
  return PEER_OPTIONS;
}

// ---------- Senha da sala ----------

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
const isNonce = (n) => typeof n === 'string' && /^[0-9a-f]{32}$/.test(n);
const isMsg = (msg) => !!msg && typeof msg === 'object' && typeof msg.t === 'string';
const newNonce = () => toHex(crypto.getRandomValues(new Uint8Array(16)));

// A senha vira duas coisas: o endereço da sala e a chave das provas. É lento de propósito (PBKDF2),
// para ninguém conseguir ficar chutando senhas.
async function derivePassword(password) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  return toHex(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('isekai-sala-dos-amigos-v2'), iterations: 310000 }, base, 512));
}

async function useKey(keyHex) {
  if (derivedFor === keyHex && ROOM && authKey) return;
  const bits = fromHex(keyHex);
  ROOM = toHex(bits.slice(0, 16));
  authKey = await crypto.subtle.importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  derivedFor = keyHex;
}

// A senha em si nunca é guardada. No PC fica só a chave que sai dela (não dá para voltar dela para a senha,
// então uma senha que a pessoa usa em outro lugar não vaza). No site não fica nada: outras páginas do mesmo
// endereço do GitHub conseguiriam ler o que ele guarda.
const KEY_STORE = 'isekai-chave';
const isKeyHex = (k) => typeof k === 'string' && /^[0-9a-f]{128}$/.test(k);
function savedKey() {
  if (!CAN_SHARE) return null;
  try { const k = localStorage.getItem(KEY_STORE); return isKeyHex(k) ? k : null; } catch { return null; }
}

// "Impressão digital" da criptografia de uma conexão (DTLS). Entra nas provas: se alguém no meio do caminho
// (até o próprio servidor do PeerJS) tentar se passar por um dos lados, as impressões não batem e a conexão cai.
function sdpFingerprint(desc) {
  const m = desc && desc.sdp && desc.sdp.match(/a=fingerprint:(\S+) ([0-9A-Fa-f:]+)/);
  return m ? m[1].toLowerCase() + ' ' + m[2].toUpperCase() : null;
}
function fingerprints(pc) {
  if (!pc) return null;
  const local = sdpFingerprint(pc.currentLocalDescription || pc.localDescription);
  const remote = sdpFingerprint(pc.currentRemoteDescription || pc.remoteDescription);
  return local && remote ? { local, remote } : null;
}

async function makeProof(...parts) {
  return toHex(await crypto.subtle.sign('HMAC', authKey, enc.encode(parts.join('|'))));
}

async function checkProof(proof, ...parts) {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false;
  return crypto.subtle.verify('HMAC', authKey, fromHex(proof), enc.encode(parts.join('|')));
}

const cleanName = (name) => String(name || 'Alguém').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24) || 'Alguém';

let connectTimer = null;
function startConnectTimer(text) {
  clearTimeout(connectTimer);
  connectTimer = setTimeout(() => {
    if (!inRoom) enterFailed(text);
  }, CONNECT_TIMEOUT);
}

const $ = (id) => document.getElementById(id);
const ui = {
  home: $('home'), room: $('room'), nameInput: $('nameInput'), passInput: $('passInput'),
  enterBtn: $('enterBtn'), homeError: $('homeError'),
  peopleCount: $('peopleCount'), shareBtn: $('shareBtn'), switchBtn: $('switchBtn'), shareStatus: $('shareStatus'),
  leaveBtn: $('leaveBtn'), memberList: $('memberList'), watchTitle: $('watchTitle'), stats: $('stats'),
  stage: $('stage'), video: $('video'), stageMsg: $('stageMsg'), stageEmpty: $('stageEmpty'), controls: $('controls'),
  muteBtn: $('muteBtn'), volume: $('volume'), fullBtn: $('fullBtn'),
  shareModal: $('shareModal'), shareTitle: $('shareTitle'), sourceGrid: $('sourceGrid'), appSelect: $('appSelect'),
  qualityField: $('qualityField'), qualitySelect: $('qualitySelect'),
  cancelShare: $('cancelShare'), confirmShare: $('confirmShare'), toast: $('toast'), screenWarn: $('screenWarn'),
};

let peer = null;
let myId = null;
let myName = '';
let isOwner = false;
let ownerConn = null;
let inRoom = false;
let lastOwnerMsg = 0;
let heartbeat = null;

// Só o dono usa: id -> { conn, name, streaming, lastSeen }
const members = new Map();
// O que todo mundo enxerga: [{ id, name, streaming, owner }]
let memberList = [];

// Quem transmite
let localStream = null;
let audioPipe = null;
let audioPid = null;
const outgoing = new Map(); // viewerId -> MediaConnection

// Quem assiste
let watching = null;
let watchAskedAt = 0;
let incoming = null;
let statsTimer = null;

// ---------- Tela inicial ----------

try { ui.nameInput.value = localStorage.getItem('isekai-name') || ''; } catch {}
try { localStorage.removeItem('isekai-senha'); } catch {}
if (savedKey()) ui.passInput.placeholder = 'Senha salva neste PC (digite só para trocar)';
try { if (QUALITIES[localStorage.getItem('isekai-quality')]) ui.qualitySelect.value = localStorage.getItem('isekai-quality'); } catch {}

function readName() {
  const name = ui.nameInput.value.trim();
  if (!name) {
    showHomeError('Coloca seu nome primeiro.');
    ui.nameInput.focus();
    return null;
  }
  try { localStorage.setItem('isekai-name', name); } catch {}
  return name;
}

function readPassword() {
  const pass = ui.passInput.value;
  if (!pass && savedKey()) return { saved: savedKey() };
  if (pass.length < MIN_PASSWORD) {
    showHomeError('A senha da sala precisa ter pelo menos ' + MIN_PASSWORD + ' letras ou números.');
    ui.passInput.focus();
    return null;
  }
  return { pass };
}

function showHomeError(text) {
  ui.homeError.textContent = text;
  ui.homeError.hidden = !text;
}

function setHomeBusy(busy) {
  ui.enterBtn.disabled = busy;
}

let password = null;
ui.enterBtn.onclick = () => {
  const name = readName();
  if (!name) return;
  const pass = readPassword();
  if (!pass) return;
  myName = name;
  password = pass;
  showHomeError('');
  setHomeBusy(true);
  enterSala();
};

ui.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.enterBtn.click(); });
ui.passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.enterBtn.click(); });

// ---------- Entrar ----------

// Tenta entrar na sala; se ninguém estiver segurando, eu seguro. Se dois tentarem segurar juntos,
// quem perde entra como convidado. O limite evita ficar trocando para sempre.
let enterTries = 0;
async function enterSala() {
  enterTries = 0;
  try {
    // Deriva uma vez só: nas reconexões usa a chave que já saiu da senha.
    if (password.pass) {
      const key = await derivePassword(password.pass);
      password = { saved: key };
      ui.passInput.value = '';
      if (CAN_SHARE) {
        try { localStorage.setItem(KEY_STORE, key); } catch {}
        ui.passInput.placeholder = 'Senha salva neste PC (digite só para trocar)';
      }
    }
    await useKey(password.saved);
  } catch (err) {
    console.error(err);
    return enterFailed('Este navegador não tem a segurança necessária para entrar na sala. Abra pelo endereço https do site.');
  }
  joinRoom(ROOM);
}

function switchEnter(fn) {
  if (peer) { peer.destroy(); peer = null; }
  if (++enterTries > 6) return enterFailed('Não consegui entrar na sala. Tenta de novo daqui a pouco.');
  fn(ROOM);
}

function enterFailed(text) {
  clearTimeout(connectTimer);
  if (peer) { peer.destroy(); peer = null; }
  if (localStream) stopShare(true);
  showHome();
  setHomeBusy(false);
  showHomeError(text);
}

async function createRoom(code) {
  const options = await peerOptions();
  startConnectTimer('Não consegui falar com o servidor das salas. Confere sua internet e tenta de novo.');
  peer = new Peer(ROOM_PREFIX + code, options);
  peer.on('open', (id) => {
    myId = id;
    isOwner = true;
    members.set(myId, { conn: null, name: myName, streaming: false, lastSeen: Date.now() });
    const firstTime = !rewatchName && !localStream;
    enterRoom();
    broadcastMembers();
    if (firstTime) toast('Você abriu a sala. Se esperava encontrar alguém aqui, confere se a senha está igual à deles.', 7000);
  });
  peer.on('connection', (conn) => {
    acceptMember(conn);
    // Tem internet que recebe conexão mas não consegue abrir uma: se a de quem entrou não abrir, eu ligo de volta.
    const p = peer;
    setTimeout(() => {
      if (conn.open || members.has(conn.peer) || p !== peer || p.destroyed) return;
      const back = p.connect(conn.peer, { reliable: true, metadata: { isekai: 'reverse' } });
      if (back) acceptMember(back);
    }, 5000);
  });
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      // Alguém segurou a sala antes de mim: entro como convidado.
      if (!inRoom) return switchEnter(joinRoom);
      // Caí do servidor e, nesse meio-tempo, outro assumiu a sala: junto todo mundo na dele.
      return rejoin('A sala mudou de lugar. Reconectando...');
    }
    handlePeerError(err);
  });
  setupMedia(peer);
}

// Dono: ninguém entra na lista sem provar que sabe a senha. Até provar, tudo que a pessoa mandar é ignorado.
function acceptMember(conn) {
  const auth = { nonce: null, done: false };
  // Em fila: a prova leva um instante para conferir e a mensagem seguinte não pode passar na frente.
  let queue = Promise.resolve();
  conn.on('data', (msg) => {
    queue = queue.then(async () => {
      if (!isMsg(msg)) return;
      if (auth.done) ownerHandle(conn.peer, msg, conn);
      else await ownerAuth(conn, msg, auth);
    }).catch((err) => { console.warn('auth', err); conn.close(); });
  });
  setTimeout(() => { if (!auth.done) conn.close(); }, AUTH_TIMEOUT);
  // Só tira da sala se for a ligação que a pessoa está usando (pode ter uma de ida e uma de volta).
  const gone = () => { const m = members.get(conn.peer); if (m && m.conn === conn) removeMember(conn.peer); };
  conn.on('close', gone);
  conn.on('error', gone);
}

async function joinRoom(code) {
  const options = await peerOptions();
  startConnectTimer('Não consegui falar com o servidor das salas. Confere sua internet e tenta de novo.');
  peer = new Peer(options);
  peer.on('open', (id) => {
    myId = id;
    startConnectTimer('Achei a sala, mas não consegui conectar no PC de quem criou. A internet de um de vocês está bloqueando a conexão direta.');
    useOwnerConn(peer.connect(ROOM_PREFIX + code, { reliable: true }), code);
    // Se a sala acabou de trocar de dono, o pedido pode ter ido para quem já saiu: tento de novo.
    const p = peer;
    setTimeout(() => { if (!inRoom && peer === p) switchEnter(joinRoom); }, 12000);
  });
  // A ligação de volta do dono, para quando a minha não consegue sair daqui.
  peer.on('connection', (conn) => {
    if (conn.peer === ROOM_PREFIX + code && conn.metadata && conn.metadata.isekai === 'reverse') useOwnerConn(conn, code);
    else conn.close();
  });
  peer.on('error', handlePeerError);
  setupMedia(peer);
}

async function ownerAuth(conn, msg, auth) {
  if (msg.t === 'hello' && !auth.nonce && isNonce(msg.n)) {
    const fp = fingerprints(conn.peerConnection);
    if (!fp) { conn.close(); return; }
    auth.nonce = newNonce();
    conn.send({ t: 'challenge', n: auth.nonce, proof: await makeProof('dono', msg.n, myId, conn.peer, fp.local, fp.remote) });
  } else if (msg.t === 'auth' && auth.nonce) {
    // Uma tentativa só: errou, cai fora.
    const nonce = auth.nonce;
    auth.nonce = null;
    const fp = fingerprints(conn.peerConnection);
    const ok = !!fp && await checkProof(msg.proof, 'convidado', nonce, conn.peer, myId, fp.remote, fp.local);
    if (!ok || !peer || peer.destroyed || !isOwner) { conn.close(); return; }
    auth.done = true;
    const old = members.get(conn.peer);
    members.set(conn.peer, { conn, name: cleanName(msg.name), streaming: old ? old.streaming : false, lastSeen: Date.now() });
    broadcastMembers();
  } else {
    conn.close();
  }
}

// Convidado: só confio no dono depois que ele provar que sabe a senha (protege contra alguém que tenha
// descoberto o endereço da sala e esteja se passando por dono).
function useOwnerConn(conn, code) {
  let nonce = null;
  let trusted = false;
  conn.on('open', () => {
    if (ownerConn) { conn.close(); return; }
    nonce = newNonce();
    conn.send({ t: 'hello', n: nonce });
  });
  let queue = Promise.resolve();
  conn.on('data', (msg) => { queue = queue.then(() => fromOwner(msg)).catch((err) => console.warn('dono', err)); });
  async function fromOwner(msg) {
    if (!isMsg(msg)) return;
    if (!trusted) {
      if (msg.t !== 'challenge' || !nonce || ownerConn) return;
      const mine = nonce;
      nonce = null;
      let ok = false;
      const fp = fingerprints(conn.peerConnection);
      try { ok = !!fp && isNonce(msg.n) && await checkProof(msg.proof, 'dono', mine, conn.peer, myId, fp.remote, fp.local); } catch {}
      if (!ok) {
        conn.close();
        if (!inRoom) enterFailed('A sala não confirmou a senha. Confere a senha e tenta de novo.');
        return;
      }
      if (ownerConn || !peer || peer.destroyed) { conn.close(); return; }
      trusted = true;
      ownerConn = conn;
      isOwner = false;
      lastOwnerMsg = Date.now();
      conn.send({ t: 'auth', proof: await makeProof('convidado', msg.n, myId, conn.peer, fp.local, fp.remote), name: myName });
      enterRoom();
      return;
    }
    if (conn !== ownerConn) return;
    lastOwnerMsg = Date.now();
    memberHandle(msg);
  }
  conn.on('close', () => { if (conn === ownerConn) rejoin('Quem segurava a sala saiu. Reconectando...'); });
}

function handlePeerError(err) {
  console.warn('peer', err.type, err);
  if (!inRoom) {
    // Ninguém segurando a sala: eu seguro.
    if (err.type === 'peer-unavailable') return switchEnter(createRoom);
    if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') enterFailed('Sem conexão com o servidor. Confere sua internet e tenta de novo.');
    else enterFailed('Não deu para conectar (' + err.type + ').');
    return;
  }
  // Na sala, "peer-unavailable" é alguém que saiu no meio de uma chamada: a lista se ajusta sozinha.
  if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
    if (peer && peer.disconnected && !peer.destroyed) peer.reconnect();
  }
}

function enterRoom() {
  clearTimeout(connectTimer);
  inRoom = true;
  setHomeBusy(false);
  ui.home.hidden = true;
  ui.room.hidden = false;
  document.body.classList.add('in-room');
  ui.shareBtn.hidden = !CAN_SHARE;
  renderMembers();
  showStage();
  clearInterval(heartbeat);
  heartbeat = setInterval(tick, 4000);
  // Voltando depois que a sala trocou de dono: continua transmitindo.
  if (localStream) { sendToOwner({ t: 'streaming', on: true }); updateShareUi(); }
}

// Dono: avisa a lista a cada volta e tira quem sumiu. Os outros: dão sinal de vida e percebem se o dono caiu.
function tick() {
  if (isOwner) {
    const now = Date.now();
    for (const [id, m] of members) {
      if (id !== myId && now - m.lastSeen > 15000) {
        try { m.conn.close(); } catch {}
        members.delete(id);
      }
    }
    broadcastMembers();
  } else if (ownerConn) {
    ownerConn.send({ t: 'ping' });
    if (Date.now() - lastOwnerMsg > 15000) rejoin('Perdi a conexão com a sala. Reconectando...');
  }
  // Pede de novo se a pessoa voltou a transmitir ou se o primeiro pedido se perdeu.
  if (watching && watching !== myId && !incoming && Date.now() - watchAskedAt > 8000) {
    const target = memberList.find((m) => m.id === watching);
    if (target && target.streaming) askToWatch(watching);
  }
  // Se a ligação com o servidor das salas cair, o código some para quem tenta entrar
  // (e as chamadas novas não chegam): registra de novo com o mesmo id.
  if (peer && peer.disconnected && !peer.destroyed) peer.reconnect();
}

function leaveRoom() {
  if (isOwner) {
    for (const [id, m] of members) if (id !== myId) { try { m.conn.send({ t: 'closed' }); } catch {} }
  }
  setTimeout(resetAll, isOwner ? 300 : 0);
}

// O dono saiu ou caiu: entro de novo sem sair da tela. Um de nós assume a sala; quem transmitia continua
// transmitindo e quem assistia volta a assistir a mesma pessoa (pelo nome, porque o id de quem assume muda).
let rewatchName = null;
function rejoin(text) {
  if (!inRoom) return;
  toast(text);
  const target = memberList.find((m) => m.id === watching);
  rewatchName = target && target.id !== myId ? target.name : null;
  resetAll(true);
  // Espera um pouco diferente para cada um, para não tentarem segurar a sala todos ao mesmo tempo.
  setTimeout(() => { if (!inRoom && !peer) enterSala(); }, 300 + Math.random() * 1500);
}

function resetAll(keepShare) {
  inRoom = false;
  clearInterval(heartbeat);
  if (keepShare) for (const id of [...outgoing.keys()]) closeOutgoing(id);
  else stopShare(true);
  stopWatching();
  members.clear();
  memberList = [];
  ownerConn = null;
  isOwner = false;
  if (peer) { peer.destroy(); peer = null; }
  if (keepShare) { renderMembers(); return; }
  rewatchName = null;
  showHome();
  setHomeBusy(false);
}

function showHome() {
  ui.room.hidden = true;
  ui.home.hidden = false;
  document.body.classList.remove('in-room', 'watching');
}

ui.leaveBtn.onclick = leaveRoom;

// ---------- Mensagens ----------

// Tudo que vai para o dono passa por aqui (se eu sou o dono, trato na hora).
function sendToOwner(msg) {
  if (isOwner) ownerHandle(myId, msg, null);
  else if (ownerConn) ownerConn.send(msg);
}

function deliver(id, msg) {
  if (id === myId) return memberHandle(msg);
  const m = members.get(id);
  if (m && m.conn) { try { m.conn.send(msg); } catch {} }
}

function ownerHandle(from, msg, conn) {
  if (!isMsg(msg)) return;
  const m = members.get(from);
  // Só quem está na lista (já provou a senha) e pela ligação que está usando.
  if (!m || (conn && m.conn !== conn)) return;
  m.lastSeen = Date.now();
  switch (msg.t) {
    case 'streaming':
      m.streaming = !!msg.on;
      broadcastMembers();
      break;
    case 'watch':
      if (typeof msg.target === 'string' && members.has(msg.target) && msg.target !== from) deliver(msg.target, { t: 'watch-req', from });
      break;
    case 'unwatch':
      if (typeof msg.target === 'string' && members.has(msg.target)) deliver(msg.target, { t: 'unwatch-req', from });
      break;
    case 'media-proof':
      if (typeof msg.target === 'string' && members.has(msg.target) && typeof msg.proof === 'string' && msg.proof.length === 64) {
        deliver(msg.target, { t: 'media-proof', from, proof: msg.proof });
      }
      break;
  }
}

function removeMember(id) {
  if (!members.has(id)) return;
  members.delete(id);
  broadcastMembers();
}

function broadcastMembers() {
  const list = [...members].map(([id, m]) => ({ id, name: m.name, streaming: m.streaming, owner: id === myId }));
  for (const id of members.keys()) deliver(id, { t: 'members', list });
}

function memberHandle(msg) {
  if (!isMsg(msg)) return;
  switch (msg.t) {
    case 'members':
      memberList = (Array.isArray(msg.list) ? msg.list : [])
        .filter((m) => m && typeof m.id === 'string' && m.id.length <= 64)
        .slice(0, 50)
        .map((m) => ({ id: m.id, name: cleanName(m.name), streaming: !!m.streaming, owner: !!m.owner }));
      for (const id of outgoing.keys()) if (!memberList.some((m) => m.id === id)) closeOutgoing(id);
      if (watching) {
        const target = memberList.find((m) => m.id === watching);
        if (!target) stopWatching();
        else if (!target.streaming && incoming) { closeIncoming(); showStage(); }
      }
      if (rewatchName && !watching) {
        const again = memberList.find((m) => m.streaming && m.name === rewatchName && m.id !== myId);
        if (again) { rewatchName = null; selectMember(again.id); }
      }
      renderMembers();
      showStage();
      break;
    case 'watch-req':
      if (localStream && isMember(msg.from) && msg.from !== myId) callViewer(msg.from);
      break;
    case 'unwatch-req':
      if (typeof msg.from === 'string') closeOutgoing(msg.from);
      break;
    case 'media-proof':
      if (typeof msg.from === 'string') onMediaProof(msg.from, msg.proof);
      break;
    case 'closed':
      rejoin('Quem segurava a sala saiu. Reconectando...');
      break;
  }
}

const isMember = (id) => typeof id === 'string' && memberList.some((m) => m.id === id);

// ---------- Lista de pessoas ----------

function renderMembers() {
  ui.peopleCount.textContent = memberList.length === 1 ? '1 pessoa na sala' : memberList.length + ' pessoas na sala';
  ui.memberList.replaceChildren(...memberList.map((m) => {
    const li = document.createElement('li');
    li.className = 'member' + (m.streaming ? ' live' : '') + (m.id === watching ? ' selected' : '');
    const top = document.createElement('div');
    top.className = 'member-top';
    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = m.name;
    top.append(name);
    if (m.owner) top.append(badge('DONO'));
    if (m.id === myId) top.append(badge('VOCÊ'));
    const state = document.createElement('div');
    state.className = 'member-state';
    state.textContent = m.streaming ? 'Transmitindo' : 'Na sala';
    li.append(top, state);
    if (m.streaming) li.onclick = () => selectMember(m.id);
    return li;
  }));
}

function badge(text) {
  const b = document.createElement('span');
  b.className = 'badge';
  b.textContent = text;
  return b;
}

// ---------- Assistir ----------

function selectMember(id) {
  if (id === watching) return;
  stopWatching();
  watching = id;
  if (id !== myId) askToWatch(id);
  renderMembers();
  showStage();
}

function askToWatch(id) {
  watchAskedAt = Date.now();
  sendToOwner({ t: 'watch', target: id });
}

function stopWatching() {
  if (watching && watching !== myId && inRoom) sendToOwner({ t: 'unwatch', target: watching });
  closeIncoming();
  watching = null;
  if (inRoom) { renderMembers(); showStage(); }
}

function closeIncoming() {
  if (!incoming) return;
  const call = incoming;
  incoming = null;
  try { call.close(); } catch {}
  clearInterval(statsTimer);
  ui.stats.textContent = '';
}

function setupMedia(p) {
  p.on('call', (call) => {
    if (call.metadata && call.metadata.isekai === 'reverse') return answerReverse(call);
    if (call.peer !== watching) { call.close(); return; }
    call.answer(undefined, { sdpTransform: tuneSdp });
    watchCall(call);
  });
}

// Quem assiste prova para quem transmite (pelo dono) que está na sala e que a conexão do vídeo é mesmo com ele.
function sendMediaProof(call) {
  let sent = false;
  const pc = call.peerConnection;
  const trySend = async () => {
    if (sent || incoming !== call) return;
    const fp = fingerprints(call.peerConnection);
    if (!fp) return;
    sent = true;
    sendToOwner({ t: 'media-proof', target: call.peer, proof: await makeProof('midia', myId, call.peer, fp.local, fp.remote) });
  };
  if (pc) {
    pc.addEventListener('signalingstatechange', trySend);
    pc.addEventListener('connectionstatechange', trySend);
  }
  trySend();
}

function watchCall(call) {
  closeIncoming();
  incoming = call;
  sendMediaProof(call);
  call.on('stream', (stream) => {
    if (incoming !== call) return;
    ui.video.srcObject = stream;
    ui.video.muted = ui.video.dataset.muted === '1';
    playVideo();
    showStage();
    startStats(call);
  });
  call.on('close', () => {
    if (incoming !== call) return;
    incoming = null;
    clearInterval(statsTimer);
    ui.stats.textContent = '';
    showStage();
  });
  // Se o vídeo não conectar, tento ao contrário: eu ligo para quem transmite. Se essa também
  // falhar, o tick pede do jeito normal de novo, e assim vai alternando.
  setTimeout(() => {
    const pc = call.peerConnection;
    if (incoming !== call || (pc && pc.connectionState === 'connected')) return;
    const target = call.peer;
    closeIncoming();
    showStage();
    if (watching === target && !(call.metadata && call.metadata.isekai === 'reverse')) reverseCall(target);
  }, 8000);
}

function reverseCall(target) {
  const call = peer.call(target, placeholderStream(), { metadata: { isekai: 'reverse' }, sdpTransform: tuneSdp });
  if (call) watchCall(call);
}

// Faixas paradas só para a ligação ao contrário ter lugar de vídeo e som para quem transmite responder.
let placeholder = null;
function placeholderStream() {
  if (!placeholder) {
    const canvas = Object.assign(document.createElement('canvas'), { width: 2, height: 2 });
    canvas.getContext('2d').fillRect(0, 0, 2, 2);
    const video = canvas.captureStream(0).getVideoTracks()[0];
    const audio = new AudioContext().createMediaStreamDestination().stream.getAudioTracks()[0];
    placeholder = new MediaStream([video, audio]);
  }
  return placeholder;
}

// Quem transmite recebendo a ligação ao contrário: responde com a transmissão.
function answerReverse(call) {
  // Só manda a transmissão para quem está na sala (quem provou a senha).
  if (!localStream || !isMember(call.peer) || call.peer === myId) { call.close(); return; }
  closeOutgoing(call.peer);
  call.answer(localStream, { sdpTransform: tuneSdp });
  trackOutgoing(call.peer, call);
}

// O que aparece no palco depende de quem está selecionado e se o vídeo já chegou.
function showStage() {
  const target = memberList.find((m) => m.id === watching);
  let msg = '';
  let video = null;
  if (!watching || !target) {
    ui.watchTitle.textContent = 'Nenhuma transmissão selecionada';
    msg = memberList.some((m) => m.streaming)
      ? 'Escolha uma pessoa que esteja transmitindo para assistir.'
      : CAN_SHARE
        ? 'Ninguém está transmitindo agora. Clique em "Compartilhar tela" para começar.'
        : 'Ninguém está transmitindo agora. Quando alguém compartilhar a tela pelo PC, aparece aqui.';
  } else if (watching === myId) {
    ui.watchTitle.textContent = 'Sua transmissão (prévia sem som)';
    if (localStream) video = localStream;
    else msg = 'Você não está transmitindo.';
  } else {
    ui.watchTitle.textContent = 'Assistindo ' + target.name;
    if (!target.streaming) msg = target.name + ' parou de transmitir. Assim que voltar, aparece aqui.';
    else if (incoming && ui.video.srcObject) video = ui.video.srcObject;
    else msg = 'Conectando com ' + target.name + '...';
  }
  if (video) {
    if (ui.video.srcObject !== video) ui.video.srcObject = video;
    ui.video.muted = watching === myId || ui.video.dataset.muted === '1';
    if (ui.video.paused) playVideo();
    ui.video.hidden = false;
    ui.controls.hidden = watching === myId;
    ui.stageEmpty.hidden = true;
  } else {
    ui.video.srcObject = null;
    ui.video.hidden = true;
    ui.controls.hidden = true;
    ui.stageEmpty.hidden = false;
    ui.stageMsg.textContent = msg;
  }
  // Com vídeo na tela, as luzinhas param para não gastar placa de vídeo à toa.
  document.body.classList.toggle('watching', !!video);
}

function startStats(call) {
  clearInterval(statsTimer);
  let lastBytes = 0;
  let lastTime = 0;
  statsTimer = setInterval(async () => {
    const pc = call.peerConnection;
    if (!pc) return;
    const report = await pc.getStats();
    let video = null;
    const codecs = new Map();
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') video = s;
      if (s.type === 'codec') codecs.set(s.id, s.mimeType);
    });
    if (!video) return;
    const mbps = lastTime ? ((video.bytesReceived - lastBytes) * 8) / ((video.timestamp - lastTime) * 1000) : 0;
    lastBytes = video.bytesReceived;
    lastTime = video.timestamp;
    const codec = (codecs.get(video.codecId) || '').replace('video/', '');
    const parts = [];
    if (video.frameHeight) parts.push(video.frameHeight + 'p');
    if (video.framesPerSecond) parts.push(Math.round(video.framesPerSecond) + ' fps');
    if (mbps) parts.push(mbps.toFixed(1) + ' Mbps');
    if (codec) parts.push(codec);
    ui.stats.textContent = parts.join(' · ');
  }, 1000);
}

// Controles do player
ui.volume.oninput = () => {
  ui.video.volume = Number(ui.volume.value);
  if (ui.video.volume > 0 && ui.video.muted) toggleMute(false);
};
ui.muteBtn.onclick = () => toggleMute(!ui.video.muted);
function toggleMute(muted) {
  ui.video.muted = muted;
  ui.video.dataset.muted = muted ? '1' : '';
  ui.muteBtn.textContent = muted ? '🔇' : '🔊';
}
// Celular e navegador não deixam tocar com som sem um toque na tela: começa mudo e pede para ligar o som.
function playVideo() {
  ui.video.play().catch(() => {
    if (ui.video.muted) return;
    toggleMute(true);
    ui.video.play().catch(() => {});
    toast('Toque em 🔇 para ligar o som.', 6000);
  });
}

function toggleFullscreen() {
  const fsElement = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    return;
  }
  const request = ui.stage.requestFullscreen || ui.stage.webkitRequestFullscreen;
  if (request) {
    Promise.resolve(request.call(ui.stage))
      .then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'))
      .catch(() => {});
  } else if (ui.video.webkitEnterFullscreen) {
    // iPhone: só o próprio vídeo entra em tela cheia.
    ui.video.webkitEnterFullscreen();
  }
}
ui.fullBtn.onclick = toggleFullscreen;
ui.stage.addEventListener('dblclick', () => { if (!ui.video.hidden) toggleFullscreen(); });

// Esconde o mouse e os controles quando fica parado em cima do vídeo.
let idleTimer = null;
ui.stage.addEventListener('mousemove', () => {
  ui.stage.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => ui.stage.classList.add('idle'), 2500);
});

// ---------- Transmitir ----------

let sources = [];
let sourceKind = 'window';
let chosenSource = null;

ui.shareBtn.onclick = () => {
  if (localStream) stopShare(false);
  else openShareModal(false);
};
ui.switchBtn.onclick = () => openShareModal(true);

// A mesma janela serve para começar e para trocar. Na troca a qualidade fica como está: ela foi combinada
// com quem assiste no começo da chamada e mudar exigiria reconectar todo mundo.
async function openShareModal(switching) {
  chosenSource = null;
  ui.shareTitle.textContent = switching ? 'Trocar para o quê?' : 'O que você quer compartilhar?';
  ui.confirmShare.textContent = switching ? 'Trocar' : 'Compartilhar';
  ui.qualityField.hidden = switching;
  ui.confirmShare.disabled = true;
  ui.sourceGrid.replaceChildren();
  ui.shareModal.hidden = false;
  const [srcs, apps] = await Promise.all([window.isekai.getSources(), window.isekai.listApps()]);
  sources = srcs;
  fillApps(apps);
  // Na troca, o som continua no programa atual até a pessoa escolher outro.
  if (switching && audioPid && [...ui.appSelect.options].some((o) => o.value === String(audioPid))) ui.appSelect.value = String(audioPid);
  renderSources();
}

function fillApps(apps) {
  ui.appSelect.replaceChildren();
  const none = new Option('Sem som', '');
  ui.appSelect.append(none);
  apps.sort((a, b) => a.name.localeCompare(b.name));
  for (const a of apps) {
    const label = a.name + ' — ' + (a.title.length > 60 ? a.title.slice(0, 57) + '...' : a.title);
    const opt = new Option(label, String(a.pid));
    opt.dataset.title = a.title;
    ui.appSelect.append(opt);
  }
}

function renderSources() {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.kind === sourceKind));
  ui.screenWarn.hidden = sourceKind !== 'screen';
  const list = sources.filter((s) => (sourceKind === 'screen') === s.screen);
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Nada para mostrar aqui.';
    ui.sourceGrid.replaceChildren(p);
    return;
  }
  ui.sourceGrid.replaceChildren(...list.map((s) => {
    const btn = document.createElement('button');
    btn.className = 'source' + (chosenSource === s ? ' selected' : '');
    const img = document.createElement('img');
    img.src = s.thumb;
    const name = document.createElement('span');
    name.textContent = s.screen ? s.name.replace('Screen', 'Tela').replace('Entire screen', 'Tela inteira') : s.name;
    name.title = s.name;
    btn.append(img, name);
    btn.onclick = () => pickSource(s);
    btn.ondblclick = () => { pickSource(s); confirmShare(); };
    return btn;
  }));
}

// Ao escolher uma janela, já deixa marcado o som do mesmo programa.
function pickSource(s) {
  chosenSource = s;
  ui.confirmShare.disabled = false;
  if (!s.screen) {
    const match = [...ui.appSelect.options].find((o) => o.dataset.title === s.name);
    if (match) ui.appSelect.value = match.value;
  }
  renderSources();
}

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => { sourceKind = t.dataset.kind; renderSources(); };
});
ui.cancelShare.onclick = () => { ui.shareModal.hidden = true; };
ui.confirmShare.onclick = () => confirmShare();

async function confirmShare() {
  if (!chosenSource) return;
  const source = chosenSource;
  const pid = ui.appSelect.value ? Number(ui.appSelect.value) : null;
  ui.shareModal.hidden = true;
  if (localStream) {
    ui.switchBtn.disabled = true;
    try {
      await switchShare(source, pid);
    } catch (err) {
      // A transmissão antiga só sai depois que a nova captura funcionou: quem assiste nem percebe a falha.
      console.error(err);
      toast('Não deu para trocar, continua transmitindo o que estava: ' + (err.message || err), 9000);
    }
    ui.switchBtn.disabled = false;
    return;
  }
  quality = QUALITIES[ui.qualitySelect.value] || QUALITIES['720'];
  try { localStorage.setItem('isekai-quality', ui.qualitySelect.value); } catch {}
  try {
    await startShare(source, pid);
  } catch (err) {
    console.error(err);
    stopShare(true);
    toast('Não deu para compartilhar: ' + (err.message || err), 9000);
  }
}

// Alguns PCs (principalmente notebook com duas placas de vídeo) recusam um jeito de capturar e aceitam outro:
// tenta do melhor para o mais simples até um funcionar.
async function captureSource(source) {
  const attempts = [
    async () => {
      await window.isekai.selectSource(source.id);
      return navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: quality.width }, height: { max: quality.height }, frameRate: { ideal: 60, max: 60 } },
        audio: false,
      });
    },
    async () => {
      await window.isekai.selectSource(source.id);
      return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    },
    async () => {
      await window.isekai.selectSource(source.id);
      return navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxWidth: quality.width, maxHeight: quality.height, maxFrameRate: 60 } },
      });
    },
    async () => {
      await window.isekai.selectSource(source.id);
      return navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id } },
      });
    },
  ];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err) {
      console.warn('captura', err.name, err.message);
      lastError = err;
    }
  }
  // Nada funcionou: oferece reabrir com o jeito antigo de capturar do Windows (só pergunta se ainda não está nele).
  const answer = await window.isekai.captureFailed();
  if (answer === 'reabrindo') return new Promise(() => {});
  throw new Error(source.screen
    ? 'o Windows não deixou capturar essa tela (' + lastError.message + ').'
    : 'o Windows não deixou capturar essa janela. Tenta outra janela ou a aba "Telas" (' + lastError.message + ').');
}

async function captureVideo(source) {
  const stream = await captureSource(source);
  const [videoTrack] = stream.getVideoTracks();
  // Os jeitos reserva capturam no tamanho original: reduz aqui para a qualidade escolhida.
  const settings = videoTrack.getSettings();
  if (settings.width > quality.width || settings.height > quality.height) {
    await videoTrack.applyConstraints({ width: { max: quality.width }, height: { max: quality.height }, frameRate: { max: 60 } }).catch(() => {});
  }
  videoTrack.contentHint = 'motion';
  videoTrack.onended = () => stopShare(false);
  return stream;
}

async function startShare(source, pid) {
  const stream = await captureVideo(source);

  // Se o som falhar (antivírus barrando o IsekaiAudio, programa fechado...), a imagem segue sozinha.
  let audioError = null;
  if (pid) {
    try {
      audioPipe = await startAudioPipe(pid);
      audioPid = pid;
      stream.addTrack(audioPipe.track);
    } catch (err) {
      console.warn('som', err);
      audioPipe = null;
      audioError = err.message || String(err);
    }
  }
  if (audioError) toast('Transmitindo sem som: o Windows ou o antivírus bloqueou a captura do som (' + audioError + '). Libere o IsekaiAudio no antivírus.', 9000);
  localStream = stream;
  sendToOwner({ t: 'streaming', on: true });
  updateShareUi();
  if (!watching) selectMember(myId);
  else showStage();
}

// Troca o que está sendo transmitido sem desligar ninguém: a imagem nova entra no lugar da antiga dentro das
// chamadas que já estão abertas. O localStream continua o mesmo, então quem chegar depois já recebe a nova.
async function switchShare(source, pid) {
  const stream = await captureVideo(source);
  const [videoTrack] = stream.getVideoTracks();
  // A transmissão pode ter parado enquanto a captura abria.
  if (!localStream) { videoTrack.onended = null; videoTrack.stop(); return; }
  const [oldTrack] = localStream.getVideoTracks();
  oldTrack.onended = null;
  localStream.removeTrack(oldTrack);
  localStream.addTrack(videoTrack);
  await Promise.all([...outgoing.values()].filter(isVerified).map((call) => {
    const sender = senderOf(call, 'video');
    return sender ? sender.replaceTrack(videoTrack) : null;
  }));
  oldTrack.stop();
  if (pid !== audioPid) await switchAudio(pid);
  if (!localStream) return;
  for (const call of outgoing.values()) if (call.peerConnection && isVerified(call)) tuneSenders(call.peerConnection);
  toast('Transmissão trocada.');
}

async function switchAudio(pid) {
  if (audioPipe) {
    localStream.removeTrack(audioPipe.track);
    audioPipe.stop();
    audioPipe = null;
  }
  audioPid = null;
  let pipe = null;
  if (pid) {
    try {
      pipe = await startAudioPipe(pid);
    } catch (err) {
      console.warn('som', err);
      toast('Trocou a imagem, mas o som falhou (' + (err.message || err) + ').', 9000);
    }
  }
  if (!localStream) { if (pipe) pipe.stop(); return; }
  if (pipe) {
    audioPipe = pipe;
    audioPid = pid;
    localStream.addTrack(pipe.track);
  }
  const track = pipe ? pipe.track : null;
  for (const [id, call] of [...outgoing]) {
    const sender = senderOf(call, 'audio');
    if (sender && !isVerified(call)) continue;
    if (sender) await sender.replaceTrack(track);
    // Começou "Sem som": a chamada não tem lugar para som, então só essa religa (um instante sem imagem).
    else if (track) callViewer(id);
  }
}

// Pelo receiver, porque o sender fica sem track quando a transmissão está sem som.
function senderOf(call, kind) {
  const pc = call.peerConnection;
  const transceiver = pc && pc.getTransceivers().find((t) => t.receiver.track.kind === kind);
  return transceiver ? transceiver.sender : null;
}

function stopShare(silent) {
  for (const id of [...outgoing.keys()]) closeOutgoing(id);
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (audioPipe) { audioPipe.stop(); audioPipe = null; }
  audioPid = null;
  if (inRoom && !silent) sendToOwner({ t: 'streaming', on: false });
  if (watching === myId) { watching = null; if (inRoom) renderMembers(); }
  updateShareUi();
  if (inRoom) showStage();
}

function updateShareUi() {
  const live = !!localStream;
  ui.shareBtn.textContent = live ? 'Parar transmissão' : 'Compartilhar tela';
  ui.shareBtn.classList.toggle('primary', !live);
  ui.shareBtn.classList.toggle('danger', live);
  ui.switchBtn.hidden = !live;
  ui.shareStatus.hidden = !live;
  ui.shareStatus.textContent = outgoing.size === 0 ? 'Ao vivo' : outgoing.size === 1 ? 'Ao vivo · 1 assistindo' : 'Ao vivo · ' + outgoing.size + ' assistindo';
}

function callViewer(viewerId) {
  closeOutgoing(viewerId);
  const call = peer.call(viewerId, localStream, { sdpTransform: tuneSdp });
  if (call) trackOutgoing(viewerId, call);
}

// Quem transmite só solta a imagem e o som depois que quem assiste provar que sabe a senha e que a conexão
// é direta com ele. Até lá a chamada existe, mas vai vazia.
const mediaAuth = new WeakMap(); // call -> { verified, proof }

function liveTrack(kind) {
  if (!localStream) return null;
  return (kind === 'video' ? localStream.getVideoTracks() : localStream.getAudioTracks())[0] || null;
}

function holdMedia(call) {
  const pc = call.peerConnection;
  if (!pc) return;
  for (const sender of pc.getSenders()) if (sender.track) sender.replaceTrack(null).catch(() => {});
}

async function onMediaProof(viewerId, proof) {
  const call = outgoing.get(viewerId);
  if (!call) return;
  const state = mediaAuth.get(call);
  if (!state || state.verified) return;
  if (typeof proof === 'string') state.proof = proof;
  const fp = fingerprints(call.peerConnection);
  if (!fp || !state.proof) return;
  const ok = await checkProof(state.proof, 'midia', viewerId, myId, fp.remote, fp.local).catch(() => false);
  if (outgoing.get(viewerId) !== call || state.verified) return;
  if (!ok) { console.warn('prova do vídeo não bateu', viewerId); closeOutgoing(viewerId); return; }
  state.verified = true;
  const pc = call.peerConnection;
  for (const kind of ['video', 'audio']) {
    const sender = senderOf(call, kind);
    if (sender) await sender.replaceTrack(liveTrack(kind)).catch(() => {});
  }
  if (pc.connectionState === 'connected') tuneSenders(pc);
}

const isVerified = (call) => !!(mediaAuth.get(call) || {}).verified;

function trackOutgoing(viewerId, call) {
  outgoing.set(viewerId, call);
  mediaAuth.set(call, { verified: false, proof: null });
  holdMedia(call);
  const pc = call.peerConnection;
  const onState = () => {
    if (pc.connectionState === 'connected' && isVerified(call)) tuneSenders(pc);
    onMediaProof(viewerId);
  };
  pc.addEventListener('connectionstatechange', onState);
  pc.addEventListener('signalingstatechange', () => onMediaProof(viewerId));
  call.on('close', () => {
    if (outgoing.get(viewerId) === call) { outgoing.delete(viewerId); updateShareUi(); }
  });
  call.on('error', () => closeOutgoing(viewerId));
  updateShareUi();
}

function closeOutgoing(id) {
  const call = outgoing.get(id);
  if (!call) return;
  outgoing.delete(id);
  try { call.close(); } catch {}
  updateShareUi();
}

// ---------- Som de um programa só ----------

let audioCtx = null;
let workletReady = null;
let pcmLeftover = null;

async function startAudioPipe(pid) {
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    workletReady = audioCtx.audioWorklet.addModule('audio-worklet.js');
  }
  await workletReady;
  await audioCtx.resume();
  const node = new AudioWorkletNode(audioCtx, 'pcm-player', { outputChannelCount: [2] });
  const dest = audioCtx.createMediaStreamDestination();
  dest.channelCount = 2;
  node.connect(dest);
  pcmLeftover = null;
  currentNode = node;

  const result = await window.isekai.startAudio(pid);
  if (!result.ok) {
    node.disconnect();
    currentNode = null;
    throw new Error(result.error);
  }
  const [track] = dest.stream.getAudioTracks();
  return {
    track,
    stop() {
      window.isekai.stopAudio();
      if (currentNode === node) currentNode = null;
      node.disconnect();
      track.stop();
    },
  };
}

let currentNode = null;
window.isekai.onAudio((chunk) => {
  if (!currentNode) return;
  // Os pedaços chegam em tamanhos quaisquer; cada amostra estéreo tem 4 bytes.
  let bytes = chunk;
  if (pcmLeftover) {
    const joined = new Uint8Array(pcmLeftover.length + chunk.length);
    joined.set(pcmLeftover);
    joined.set(chunk, pcmLeftover.length);
    bytes = joined;
    pcmLeftover = null;
  }
  const usable = bytes.length - (bytes.length % 4);
  if (usable < bytes.length) pcmLeftover = bytes.slice(usable);
  const copy = bytes.slice(0, usable);
  const ints = new Int16Array(copy.buffer, copy.byteOffset, usable / 2);
  const floats = new Float32Array(ints.length);
  for (let i = 0; i < ints.length; i++) floats[i] = ints[i] / 32768;
  currentNode.port.postMessage(floats, [floats.buffer]);
});
window.isekai.onAudioEnded(() => {
  if (audioPipe && localStream) toast('O programa do som fechou. A imagem continua sem som.');
});

// ---------- Qualidade ----------

// Opus em estéreo com bitrate alto (o padrão é mono e pensado para voz), vídeo começando já forte
// e H264 na frente: na maioria dos PCs ele é codificado pela placa de vídeo, o que segura 60 fps sem pesar.
function tuneSdp(sdp) {
  const opus = (sdp.match(/a=rtpmap:(\d+) opus\/48000/i) || [])[1];
  let section = '';
  return preferH264(sdp).split('\r\n').map((line) => {
    if (line.startsWith('m=')) section = line.slice(2).split(' ')[0];
    if (opus && line.startsWith('a=fmtp:' + opus + ' ')) {
      return setFmtp(line, { stereo: 1, 'sprop-stereo': 1, maxaveragebitrate: AUDIO_BITRATE, useinbandfec: 1, usedtx: 0, cbr: 0 });
    }
    if (section === 'video' && /^a=fmtp:\d+ /.test(line) && !line.includes('apt=')) {
      return setFmtp(line, { 'x-google-start-bitrate': Math.round(quality.bitrate * 0.6 / 1000), 'x-google-max-bitrate': quality.bitrate / 1000 });
    }
    return line;
  }).join('\r\n');
}

function setFmtp(line, values) {
  const space = line.indexOf(' ');
  const head = line.slice(0, space);
  const params = new Map(line.slice(space + 1).split(';').filter(Boolean).map((p) => {
    const eq = p.indexOf('=');
    return eq < 0 ? [p.trim(), ''] : [p.slice(0, eq).trim(), p.slice(eq + 1)];
  }));
  for (const [k, v] of Object.entries(values)) params.set(k, String(v));
  return head + ' ' + [...params].map(([k, v]) => (v === '' ? k : k + '=' + v)).join(';');
}

// Reordena os codecs da linha m=video: H264 High, outros H264, VP9, VP8 e o resto (rtx, red...) no fim.
function preferH264(sdp) {
  const sections = sdp.split(/(?=\r\nm=)/);
  return sections.map((part) => {
    const mline = part.match(/m=video [^\r\n]+/);
    if (!mline) return part;
    const [m, port, proto, ...pts] = mline[0].split(' ');
    const rank = (pt) => {
      const codec = ((part.match(new RegExp('a=rtpmap:' + pt + ' ([^/\\r\\n]+)')) || [])[1] || '').toUpperCase();
      const fmtp = (part.match(new RegExp('a=fmtp:' + pt + ' ([^\\r\\n]+)')) || [])[1] || '';
      if (codec === 'H264') return (fmtp.includes('packetization-mode=1') ? 0 : 2) + (fmtp.includes('profile-level-id=64') ? 0 : 1);
      if (codec === 'VP9') return 4;
      if (codec === 'VP8') return 5;
      return 6;
    };
    const sorted = pts.map((pt, i) => [pt, rank(pt), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map((x) => x[0]);
    return part.replace(mline[0], [m, port, proto, ...sorted].join(' '));
  }).join('');
}

async function tuneSenders(pc) {
  for (const sender of pc.getSenders()) {
    if (!sender.track) continue;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    const enc = params.encodings[0];
    if (sender.track.kind === 'video') {
      enc.maxBitrate = quality.bitrate;
      enc.maxFramerate = 60;
      enc.priority = 'high';
      enc.networkPriority = 'high';
      // Filme: se a rede apertar, prefere perder quadro a perder nitidez.
      params.degradationPreference = 'maintain-resolution';
    } else {
      enc.maxBitrate = AUDIO_BITRATE;
      enc.priority = 'high';
      enc.networkPriority = 'high';
    }
    try { await sender.setParameters(params); } catch (err) { console.warn('setParameters', err); }
  }
}

// ---------- Luzinhas flutuando no fundo ----------

(function makeLights() {
  const colors = ['#9be3cf', '#dfe9ff', '#86b8ee', '#d9bf7f'];
  const box = $('lights');
  for (let i = 0; i < 28; i++) {
    const el = document.createElement('span');
    el.className = 'light';
    el.style.left = (Math.random() * 100).toFixed(1) + '%';
    el.style.setProperty('--s', (2 + Math.random() * 3.5).toFixed(1) + 'px');
    el.style.setProperty('--c', colors[i % colors.length]);
    el.style.setProperty('--o', (0.4 + Math.random() * 0.5).toFixed(2));
    el.style.setProperty('--d', (12 + Math.random() * 16).toFixed(1) + 's');
    el.style.setProperty('--delay', (-Math.random() * 28).toFixed(1) + 's');
    el.style.setProperty('--dx', (Math.random() * 80 - 40).toFixed(0) + 'px');
    box.append(el);
  }
})();

// ---------- Aviso rápido ----------

let toastTimer = null;
function toast(text, ms = 3500) {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, ms);
}
