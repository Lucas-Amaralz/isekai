// Isekai: salas para assistir filme e série juntos, com a tela e o som de UM programa só.
const { app, BrowserWindow, ipcMain, desktopCapturer, session, nativeTheme, clipboard, dialog } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// O capturador de som fica em resources/ no desenvolvimento e ao lado do app no .exe empacotado.
const audioExe = app.isPackaged
  ? path.join(process.resourcesPath, 'IsekaiAudio.exe')
  : path.join(__dirname, 'resources', 'IsekaiAudio.exe');

let win;
let pendingSourceId = null;
let audioProc = null;

// Permite abrir duas cópias no mesmo PC para testar (cada uma com seu perfil).
if (process.env.ISEKAI_PROFILE) app.setPath('userData', path.join(app.getPath('temp'), 'isekai-' + process.env.ISEKAI_PROFILE));

// Modo compatibilidade: em alguns PCs a placa de vídeo (ou o driver dela) deixa a janela toda preta.
// Quando isso acontece o Isekai liga o modo sozinho, reabre sem usar a placa e lembra disso nas próximas vezes.
const compatFile = path.join(app.getPath('userData'), 'modo-compatibilidade');
const compat = process.argv.includes('--compat') || fs.existsSync(compatFile);
if (compat) app.disableHardwareAcceleration();

function restartInCompat(reason) {
  if (compat) return;
  console.warn('modo compatibilidade:', reason);
  try {
    fs.mkdirSync(path.dirname(compatFile), { recursive: true });
    fs.writeFileSync(compatFile, reason + '\n');
  } catch {}
  app.relaunch();
  app.exit(0);
}

// Captura alternativa: em alguns PCs o jeito novo de capturar do Windows (Windows Graphics Capture) recusa tudo
// com "Could not start video source". Com o arquivo abaixo, o Chromium usa o jeito antigo (GDI/DXGI).
const altCaptureFile = path.join(app.getPath('userData'), 'captura-alternativa');
const altCapture = process.argv.includes('--captura-alternativa') || fs.existsSync(altCaptureFile);
if (altCapture) app.commandLine.appendSwitch('disable-features', 'AllowWgcWindowCapturer,AllowWgcScreenCapturer');

ipcMain.handle('capture-failed', async () => {
  if (altCapture || !win) return 'sem-saida';
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Isekai',
    message: 'O Windows recusou a captura neste PC.',
    detail: 'Dá para reabrir o Isekai usando outro jeito de capturar a tela. Você vai sair da sala e precisa entrar de novo com o código.',
    buttons: ['Reabrir com a captura alternativa', 'Agora não'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return 'cancelado';
  try {
    fs.mkdirSync(path.dirname(altCaptureFile), { recursive: true });
    fs.writeFileSync(altCaptureFile, 'ligado\n');
  } catch {}
  app.relaunch();
  app.exit(0);
  return 'reabrindo';
});

app.on('child-process-gone',(_e, details) => {
  if (details.type === 'GPU' && details.reason !== 'clean-exit') restartInCompat('a placa de vídeo travou (' + details.reason + ')');
});

// A tela inicial tem a arte do campo de flores: se depois de abrir a janela estiver toda preta, a placa não está desenhando.
async function checkWindowDrawn() {
  if (compat || !win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return;
  let img = null;
  try { img = await win.webContents.capturePage(); } catch {}
  if (!img || img.isEmpty()) return restartInCompat('a janela não desenhou');
  const px = img.toBitmap();
  let brightest = 0;
  for (let i = 0; i < px.length; i += 4 * 97) brightest = Math.max(brightest, px[i], px[i + 1], px[i + 2]);
  if (brightest < 24) restartInCompat('a janela abriu toda preta');
}

// Sem isso o Chromium segura o vídeo quando a janela fica minimizada ou atrás do player.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    title: compat ? 'Isekai (modo compatibilidade)' : 'Isekai',
    backgroundColor: '#070a12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.webContents.once('did-finish-load', () => setTimeout(checkWindowDrawn, 4000));
  // O título da página sobrescreveria o aviso do modo compatibilidade.
  win.on('page-title-updated', (e) => e.preventDefault());
  win.on('closed', () => { stopAudio(); win = null; });
}

// O vídeo vem da tela ou janela que a pessoa escolheu no seletor do Isekai; o som vem do IsekaiAudio.
function setupCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const source = sources.find((s) => s.id === pendingSourceId);
    pendingSourceId = null;
    if (!source) return callback({});
    callback({ video: source });
  });
}

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  });
  // Janelas escondidas ou minimizadas vêm com a miniatura toda preta: vão para o fim da lista.
  const isBlack = (img) => {
    const px = img.toBitmap();
    for (let i = 0; i < px.length; i += 4 * 7) if (px[i] > 12 || px[i + 1] > 12 || px[i + 2] > 12) return false;
    return true;
  };
  return sources
    .filter((s) => s.name !== 'Isekai')
    .map((s) => ({ id: s.id, name: s.name, screen: s.id.startsWith('screen:'), thumb: s.thumbnail.toDataURL(), black: isBlack(s.thumbnail) }))
    .sort((a, b) => a.black - b.black);
});

ipcMain.handle('select-source', (_e, id) => { pendingSourceId = id; });

ipcMain.handle('list-apps', () => new Promise((resolve) => {
  // O próprio Isekai não aparece na lista de som.
  execFile(audioExe, ['list', String(process.pid)], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
    if (err) return resolve([]);
    try { resolve(JSON.parse(stdout)); } catch { resolve([]); }
  });
}));

ipcMain.handle('start-audio', (event, pid) => new Promise((resolve) => {
  stopAudio();
  const proc = spawn(audioExe, ['capture', String(pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  audioProc = proc;
  let errText = '';
  let settled = false;
  const done = (result) => { if (!settled) { settled = true; resolve(result); } };
  proc.stdout.on('data', (chunk) => {
    if (proc !== audioProc) return;
    event.sender.send('audio-pcm', chunk);
  });
  proc.stderr.on('data', (d) => { errText += d.toString(); });
  proc.on('exit', (code) => {
    // Se fui eu que parei (trocar de programa, parar a transmissão), não é para avisar que o programa fechou.
    const unexpected = proc === audioProc;
    if (unexpected) audioProc = null;
    if (code && code !== 0) done({ ok: false, error: errText.trim() || 'O capturador de som fechou.' });
    if (unexpected && !event.sender.isDestroyed()) event.sender.send('audio-ended');
  });
  proc.on('error', (err) => done({ ok: false, error: err.message }));
  // Se em 1,5 s não deu erro, a captura começou (o Windows só manda pacotes quando o programa toca som).
  setTimeout(() => done({ ok: true }), 1500);
}));

ipcMain.handle('stop-audio', () => { stopAudio(); });

// Credenciais do TURN da Cloudflare (turn.json: { "keyId": "...", "apiToken": "..." }), pedidas uma vez por abertura.
let turnCache = null;
ipcMain.handle('ice-servers', async () => {
  if (turnCache && turnCache.until > Date.now()) return turnCache.servers;
  let cfg;
  try { cfg = require('./turn.json'); } catch { return []; }
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${cfg.keyId}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.apiToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const list = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    // A porta 53 costuma ser bloqueada e só atrasa a conexão.
    const servers = list
      .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }))
      .filter((s) => s.urls.length && s.username);
    turnCache = { servers, until: Date.now() + 12 * 3600 * 1000 };
    return servers;
  } catch (err) {
    console.warn('turn', err.message);
    return [];
  }
});

ipcMain.handle('copy',(_e, text) => { clipboard.writeText(text); });

ipcMain.handle('set-fullscreen', (_e, on) => { if (win) win.setFullScreen(!!on); });

function stopAudio() {
  if (!audioProc) return;
  const proc = audioProc;
  audioProc = null;
  try { proc.stdin.end(); } catch {}
  setTimeout(() => { try { proc.kill(); } catch {} }, 1000);
}

// Atualização: procura versão nova na Release do GitHub, baixa em segundo plano e pergunta se pode reiniciar.
function setupUpdates() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Isekai',
      message: 'Chegou o Isekai ' + info.version + '.',
      detail: 'Reiniciar agora para atualizar? Se estiver no meio de um filme, pode deixar para depois: atualiza quando você fechar o Isekai.',
      buttons: ['Reiniciar agora', 'Depois'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall(true, true);
  });
  autoUpdater.on('error', (err) => console.warn('update', err && err.message));
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

app.whenReady().then(() => {
  setupCapture();
  createWindow();
  setupUpdates();
});

app.on('window-all-closed', () => {
  stopAudio();
  app.quit();
});
