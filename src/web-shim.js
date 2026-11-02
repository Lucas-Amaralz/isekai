// No programa de Windows o preload.js cria window.isekai. No site (celular ou navegador) não existe Electron:
// aqui fica só o que dá para fazer no navegador, que é entrar na sala e assistir.
if (!window.isekai) {
  window.isekai = {
    copy: async (text) => {
      try { await navigator.clipboard.writeText(text); } catch {}
    },
    iceServers: async () => [],
    onAudio() {},
    onAudioEnded() {},
  };
  document.documentElement.classList.add('web');
}
