// Isekai: salas para assistir filme e série juntos, com a tela e o som de UM programa só.
const { app, BrowserWindow, ipcMain, desktopCapturer, session, nativeTheme, clipboard, dialog, net } = require('electron');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

// Chave pública que confere as atualizações (a privada fica só no PC do Lucas, em ~/.isekai).
const UPDATE_KEY = 'MCowBQYDK2VwAyEAdanrKlVZgM+fts1cNfXqKpS8479upoayEj6gfgEDZfw=';
const path = require('path');

// O capturador de som fica em resources/ no desenvolvimento e ao lado do app no .exe empacotado.
const audioExe = app.isPackaged
  ? path.join(process.resourcesPath, 'IsekaiAudio.exe')
  : path.join(__dirname, 'resources', 'IsekaiAudio.exe');

let win;
let pendingSourceId = null;
// A permissão de "vídeo" só vale nos segundos em que o Isekai está abrindo a captura da tela que a pessoa
// escolheu. Fora disso, nenhum pedido de câmera passa (o Chromium usa a mesma permissão para os dois).
let captureWindowUntil = 0;
let audioProc = null;

// Permite abrir duas cópias no mesmo PC para testar (cada uma com seu perfil). Só no desenvolvimento.
if (!app.isPackaged && /^[\w-]{1,32}$/.test(process.env.ISEKAI_PROFILE || '')) {
  app.setPath('userData', path.join(app.getPath('temp'), 'isekai-' + process.env.ISEKAI_PROFILE));
}

// No programa instalado ninguém pode ligar a depuração por fora (ela daria acesso à tela e à transmissão).
if (app.isPackaged && ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'remote-allow-origins']
  .some((s) => app.commandLine.hasSwitch(s) || process.argv.some((a) => a.startsWith('--' + s)))) {
  app.exit(1);
}

// Segurança: o Isekai só aceita pedidos (IPC) vindos da própria tela dele, nunca de uma página de fora.
const pageUrl = require('url').pathToFileURL(path.join(__dirname, 'src', 'index.html')).href;
function fromApp(event) {
  const frame = event.senderFrame;
  return !!(win && frame && event.sender === win.webContents && frame === win.webContents.mainFrame && frame.url.split('#')[0] === pageUrl);
}
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event)) throw new Error('pedido recusado');
    return fn(event, ...args);
  });
}

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

handle('capture-failed', async () => {
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
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  // O WebRTC só usa a placa de rede principal: o IP de VPN (do trabalho, por exemplo) e de outras placas não vai para a sala.
  win.webContents.setWebRTCIPHandlingPolicy('default_public_and_private_interfaces');
  // A janela nunca sai da tela do Isekai nem abre outras janelas (um link ou página maliciosa não leva a lugar nenhum).
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-redirect', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.webContents.once('did-finish-load', () => setTimeout(checkWindowDrawn, 4000));
  // O título da página sobrescreveria o aviso do modo compatibilidade.
  win.on('page-title-updated', (e) => e.preventDefault());
  win.on('closed', () => { stopAudio(); win = null; });
}

// O vídeo vem da tela ou janela que a pessoa escolheu no seletor do Isekai; o som vem do IsekaiAudio.
function setupCapture() {
  // Permissões: só captura de tela/som e tela cheia, e só para a tela do Isekai. Câmera, microfone, localização etc.: não.
  const allowed = new Set(['media', 'display-capture', 'fullscreen']);
  const isApp = (wc, url) => !!(win && wc === win.webContents && String(url || '').split('#')[0] === pageUrl);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (!isApp(wc, details.requestingUrl) || !allowed.has(permission)) return callback(false);
    // Pedido de "media" só pode ser captura de tela, nunca câmera ou microfone.
    if (permission === 'media' && ((details.mediaTypes || []).some((t) => t !== 'video') || Date.now() > captureWindowUntil)) return callback(false);
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => (
    allowed.has(permission) && !!wc && wc === (win && win.webContents)
  ));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!win || request.frame !== win.webContents.mainFrame) return callback({});
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const source = sources.find((s) => s.id === pendingSourceId);
    pendingSourceId = null;
    if (!source) return callback({});
    callback({ video: source });
  });
}

handle('get-sources', async () => {
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

handle('select-source', (_e, id) => {
  if (typeof id !== 'string' || !/^(screen|window):[\d:-]+$/.test(id)) throw new Error('fonte inválida');
  pendingSourceId = id;
  captureWindowUntil = Date.now() + 8000;
});

handle('list-apps', () => new Promise((resolve) => {
  // O próprio Isekai não aparece na lista de som.
  execFile(audioExe, ['list', String(process.pid)], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
    if (err) return resolve([]);
    try { resolve(JSON.parse(stdout)); } catch { resolve([]); }
  });
}));

const validPid = (pid) => Number.isInteger(pid) && pid > 0 && pid < 2 ** 32;

handle('start-audio', (event, pid) => new Promise((resolve) => {
  if (!validPid(pid)) return resolve({ ok: false, error: 'programa inválido' });
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

handle('stop-audio', () => { stopAudio(); });

handle('copy', (_e, text) => { if (typeof text === 'string' && text.length <= 2000) clipboard.writeText(text); });

handle('set-fullscreen', (_e, on) => { if (win) win.setFullScreen(!!on); });

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
  // O download "só das partes que mudaram" trava com o GitHub: baixa o instalador inteiro.
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.allowDowngrade = false;
  // Sem certificado da Microsoft o electron-updater não confere quem fez o instalador. Então o Isekai confere sozinho:
  // só instala se Isekai-Setup.exe.sig (assinado pela chave do Lucas, que nunca vai pro GitHub) bater com UPDATE_KEY.
  // Quem invadir o GitHub consegue trocar o .exe, mas não consegue assinar.
  let pendingVersion = null;
  autoUpdater.on('update-available', (info) => { pendingVersion = info && info.version; });
  autoUpdater.verifySignature = async (file) => {
    try {
      if (typeof pendingVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(pendingVersion)) return 'versão desconhecida';
      const url = 'https://github.com/Lucas-Amaralz/isekai/releases/download/v' + pendingVersion + '/Isekai-Setup.exe.sig';
      const res = await net.fetch(url);
      if (!res.ok) return 'sem assinatura (' + res.status + ')';
      const text = (await res.text()).trim();
      if (!/^[A-Za-z0-9+/]{86}==$/.test(text)) return 'assinatura malformada';
      const key = crypto.createPublicKey({ key: Buffer.from(UPDATE_KEY, 'base64'), format: 'der', type: 'spki' });
      const ok = crypto.verify(null, await fs.promises.readFile(file), key, Buffer.from(text, 'base64'));
      return ok ? null : 'assinatura não confere';
    } catch (e) {
      return 'erro ao conferir: ' + (e && e.message);
    }
  };
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

// Nenhuma janela ou webview extra pode ser criada dentro do Isekai.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.whenReady().then(() => {
  setupCapture();
  createWindow();
  setupUpdates();
});

app.on('window-all-closed', () => {
  stopAudio();
  app.quit();
});
