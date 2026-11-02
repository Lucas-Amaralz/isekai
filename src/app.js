// Isekai: a sala vive no PC de quem criou (o dono). Todo mundo se conecta a ele para saber quem está na sala
// e quem está transmitindo; o vídeo vai direto de quem transmite para quem escolheu assistir.
const ROOM_PREFIX = 'isekai-sala-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
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
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
  },
};

// Servidor de apoio (TURN): faz a ponte quando a internet de alguém bloqueia a conexão direta.
async function peerOptions() {
  try {
    const turn = await window.isekai.iceServers();
    if (turn && turn.length) return { ...PEER_OPTIONS, config: { iceServers: [...PEER_OPTIONS.config.iceServers, ...turn] } };
  } catch (err) {
    console.warn('turn', err);
  }
  return PEER_OPTIONS;
}

let connectTimer = null;
function startConnectTimer(text) {
  clearTimeout(connectTimer);
  connectTimer = setTimeout(() => {
    if (inRoom) return;
    if (peer) { peer.destroy(); peer = null; }
    setHomeBusy(false);
    showHomeError(text);
  }, CONNECT_TIMEOUT);
}

const $ = (id) => document.getElementById(id);
const ui = {
  home: $('home'), room: $('room'), nameInput: $('nameInput'), codeInput: $('codeInput'),
  createBtn: $('createBtn'), joinBtn: $('joinBtn'), homeError: $('homeError'),
  roomCode: $('roomCode'), peopleCount: $('peopleCount'), shareBtn: $('shareBtn'), shareStatus: $('shareStatus'),
  leaveBtn: $('leaveBtn'), memberList: $('memberList'), watchTitle: $('watchTitle'), stats: $('stats'),
  stage: $('stage'), video: $('video'), stageMsg: $('stageMsg'), stageEmpty: $('stageEmpty'), controls: $('controls'),
  muteBtn: $('muteBtn'), volume: $('volume'), fullBtn: $('fullBtn'),
  shareModal: $('shareModal'), sourceGrid: $('sourceGrid'), appSelect: $('appSelect'), qualitySelect: $('qualitySelect'),
  cancelShare: $('cancelShare'), confirmShare: $('confirmShare'), toast: $('toast'),
};

let peer = null;
let myId = null;
let myName = '';
let roomCode = '';
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
const outgoing = new Map(); // viewerId -> MediaConnection

// Quem assiste
let watching = null;
let watchAskedAt = 0;
let incoming = null;
let statsTimer = null;

// ---------- Tela inicial ----------

try { ui.nameInput.value = localStorage.getItem('isekai-name') || ''; } catch {}
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

function showHomeError(text) {
  ui.homeError.textContent = text;
  ui.homeError.hidden = !text;
}

function setHomeBusy(busy) {
  ui.createBtn.disabled = busy;
  ui.joinBtn.disabled = busy;
}

ui.createBtn.onclick = () => {
  const name = readName();
  if (!name) return;
  myName = name;
  showHomeError('');
  setHomeBusy(true);
  createRoom();
};

ui.joinBtn.onclick = () => {
  const name = readName();
  if (!name) return;
  const code = ui.codeInput.value.trim().toUpperCase();
  if (code.length !== 6) return showHomeError('O código da sala tem 6 letras.');
  myName = name;
  showHomeError('');
  setHomeBusy(true);
  joinRoom(code);
};

ui.codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.joinBtn.click(); });
ui.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.createBtn.click(); });

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

// ---------- Criar e entrar ----------

async function createRoom() {
  const code = randomCode();
  const options = await peerOptions();
  startConnectTimer('Não consegui falar com o servidor das salas. Confere sua internet e tenta de novo.');
  peer = new Peer(ROOM_PREFIX + code, options);
  peer.on('open', (id) => {
    myId = id;
    isOwner = true;
    roomCode = code;
    members.set(myId, { conn: null, name: myName, streaming: false, lastSeen: Date.now() });
    enterRoom();
    broadcastMembers();
  });
  peer.on('connection', (conn) => {
    conn.on('data', (msg) => ownerHandle(conn.peer, msg, conn));
    conn.on('close', () => removeMember(conn.peer));
    conn.on('error', () => removeMember(conn.peer));
  });
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id' && !inRoom) {
      peer.destroy();
      return createRoom();
    }
    handlePeerError(err);
  });
  setupMedia(peer);
}

async function joinRoom(code) {
  const options = await peerOptions();
  startConnectTimer('Não consegui falar com o servidor das salas. Confere sua internet e tenta de novo.');
  peer = new Peer(options);
  peer.on('open', (id) => {
    myId = id;
    startConnectTimer('Achei a sala, mas não consegui conectar no PC de quem criou. A internet de um de vocês está bloqueando a conexão direta.');
    const conn = peer.connect(ROOM_PREFIX + code, { reliable: true });
    conn.on('open', () => {
      ownerConn = conn;
      roomCode = code;
      isOwner = false;
      lastOwnerMsg = Date.now();
      conn.send({ t: 'hello', name: myName });
      enterRoom();
    });
    conn.on('data', (msg) => { lastOwnerMsg = Date.now(); memberHandle(msg); });
    conn.on('close', () => roomClosed('A sala foi fechada por quem criou.'));
  });
  peer.on('error', handlePeerError);
  setupMedia(peer);
}

function handlePeerError(err) {
  console.warn('peer', err.type, err);
  if (!inRoom) {
    clearTimeout(connectTimer);
    setHomeBusy(false);
    if (err.type === 'peer-unavailable') showHomeError('Não achei essa sala. Confere o código.');
    else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') showHomeError('Sem conexão com o servidor. Confere sua internet e tenta de novo.');
    else showHomeError('Não deu para conectar (' + err.type + ').');
    if (peer) { peer.destroy(); peer = null; }
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
  ui.roomCode.textContent = roomCode;
  ui.shareBtn.hidden = !CAN_SHARE;
  renderMembers();
  showStage();
  clearInterval(heartbeat);
  heartbeat = setInterval(tick, 4000);
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
    if (Date.now() - lastOwnerMsg > 15000) roomClosed('Perdi a conexão com a sala.');
  }
  // Pede de novo se a pessoa voltou a transmitir ou se o primeiro pedido se perdeu.
  if (watching && watching !== myId && !incoming && Date.now() - watchAskedAt > 8000) {
    const target = memberList.find((m) => m.id === watching);
    if (target && target.streaming) askToWatch(watching);
  }
}

function leaveRoom() {
  if (isOwner) {
    for (const [id, m] of members) if (id !== myId) { try { m.conn.send({ t: 'closed' }); } catch {} }
  }
  setTimeout(resetAll, isOwner ? 300 : 0);
}

function roomClosed(text) {
  if (!inRoom) return;
  toast(text);
  resetAll();
}

function resetAll() {
  inRoom = false;
  clearInterval(heartbeat);
  stopShare(true);
  stopWatching();
  members.clear();
  memberList = [];
  ownerConn = null;
  isOwner = false;
  if (peer) { peer.destroy(); peer = null; }
  ui.room.hidden = true;
  ui.home.hidden = false;
  document.body.classList.remove('in-room', 'watching');
  setHomeBusy(false);
}

ui.leaveBtn.onclick = leaveRoom;
ui.roomCode.onclick = () => { window.isekai.copy(roomCode); toast('Código copiado! Manda pro pessoal.'); };

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
  const m = members.get(from);
  if (m) m.lastSeen = Date.now();
  switch (msg.t) {
    case 'hello':
      members.set(from, { conn, name: String(msg.name || 'Alguém').slice(0, 24), streaming: false, lastSeen: Date.now() });
      broadcastMembers();
      break;
    case 'streaming':
      if (m) { m.streaming = !!msg.on; broadcastMembers(); }
      break;
    case 'watch':
      deliver(msg.target, { t: 'watch-req', from });
      break;
    case 'unwatch':
      deliver(msg.target, { t: 'unwatch-req', from });
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
  switch (msg.t) {
    case 'members':
      memberList = Array.isArray(msg.list) ? msg.list : [];
      for (const id of outgoing.keys()) if (!memberList.some((m) => m.id === id)) closeOutgoing(id);
      if (watching) {
        const target = memberList.find((m) => m.id === watching);
        if (!target) stopWatching();
        else if (!target.streaming && incoming) { closeIncoming(); showStage(); }
      }
      renderMembers();
      showStage();
      break;
    case 'watch-req':
      if (localStream) callViewer(msg.from);
      break;
    case 'unwatch-req':
      closeOutgoing(msg.from);
      break;
    case 'closed':
      roomClosed('A sala foi fechada por quem criou.');
      break;
  }
}

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
    if (call.peer !== watching) { call.close(); return; }
    closeIncoming();
    incoming = call;
    call.answer(undefined, { sdpTransform: tuneSdp });
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
  });
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
  else openShareModal();
};

async function openShareModal() {
  chosenSource = null;
  ui.confirmShare.disabled = true;
  ui.sourceGrid.replaceChildren();
  ui.shareModal.hidden = false;
  const [srcs, apps] = await Promise.all([window.isekai.getSources(), window.isekai.listApps()]);
  sources = srcs;
  fillApps(apps);
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
  quality = QUALITIES[ui.qualitySelect.value] || QUALITIES['720'];
  try { localStorage.setItem('isekai-quality', ui.qualitySelect.value); } catch {}
  ui.shareModal.hidden = true;
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
    () => navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxWidth: quality.width, maxHeight: quality.height, maxFrameRate: 60 } },
    }),
    () => navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id } },
    }),
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

async function startShare(source, pid) {
  const stream = await captureSource(source);
  const [videoTrack] = stream.getVideoTracks();
  // Os jeitos reserva capturam no tamanho original: reduz aqui para a qualidade escolhida.
  const settings = videoTrack.getSettings();
  if (settings.width > quality.width || settings.height > quality.height) {
    await videoTrack.applyConstraints({ width: { max: quality.width }, height: { max: quality.height }, frameRate: { max: 60 } }).catch(() => {});
  }
  videoTrack.contentHint = 'motion';
  videoTrack.onended = () => stopShare(false);

  // Se o som falhar (antivírus barrando o IsekaiAudio, programa fechado...), a imagem segue sozinha.
  let audioError = null;
  if (pid) {
    try {
      audioPipe = await startAudioPipe(pid);
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

function stopShare(silent) {
  for (const id of [...outgoing.keys()]) closeOutgoing(id);
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (audioPipe) { audioPipe.stop(); audioPipe = null; }
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
  ui.shareStatus.hidden = !live;
  ui.shareStatus.textContent = outgoing.size === 0 ? 'Ao vivo' : outgoing.size === 1 ? 'Ao vivo · 1 assistindo' : 'Ao vivo · ' + outgoing.size + ' assistindo';
}

function callViewer(viewerId) {
  closeOutgoing(viewerId);
  const call = peer.call(viewerId, localStream, { sdpTransform: tuneSdp });
  if (!call) return;
  outgoing.set(viewerId, call);
  const pc = call.peerConnection;
  const onState = () => { if (pc.connectionState === 'connected') tuneSenders(pc); };
  pc.addEventListener('connectionstatechange', onState);
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
