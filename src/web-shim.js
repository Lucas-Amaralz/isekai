// No programa de Windows o preload.js cria window.isekai. No site (celular ou navegador) não existe Electron:
// aqui fica só o que dá para fazer no navegador, que é entrar na sala e assistir.
// O GitHub Pages não deixa mandar o cabeçalho que proíbe outro site de embutir este dentro dele (frame-ancestors).
// Se alguém colocar o Isekai dentro de um site falso para pegar a senha, a página se recusa a funcionar.
if (window.top !== window.self) {
  document.documentElement.innerHTML = '';
  throw new Error('Isekai não abre dentro de outro site.');
}
if (!window.isekai) {
  window.isekai = {
    copy: async (text) => {
      try { await navigator.clipboard.writeText(text); } catch {}
    },
    onAudio() {},
    onAudioEnded() {},
  };
  document.documentElement.classList.add('web');
}
