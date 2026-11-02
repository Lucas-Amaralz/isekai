// Toca o PCM que chega do IsekaiAudio (estéreo, 48 kHz) dentro do Web Audio, para virar uma faixa da transmissão.
// Guarda um pouco de folga para não picotar e descarta o excesso quando acumula, para o som não atrasar em relação à imagem.
const TARGET = 48000 * 0.06; // 60 ms de folga
const MAX = 48000 * 0.25;    // acima de 250 ms acumulados, pula para perto da folga

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 48000 * 2;
    this.left = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    this.read = 0;
    this.write = 0;
    this.count = 0;
    this.started = false;
    this.port.onmessage = (e) => this.push(e.data);
  }

  push(interleaved) {
    const frames = interleaved.length >> 1;
    for (let i = 0; i < frames; i++) {
      this.left[this.write] = interleaved[i * 2];
      this.right[this.write] = interleaved[i * 2 + 1];
      this.write = (this.write + 1) % this.size;
    }
    this.count = Math.min(this.count + frames, this.size);
    if (this.count > MAX) {
      const drop = this.count - TARGET;
      this.read = (this.read + drop) % this.size;
      this.count = TARGET;
    }
  }

  process(_inputs, outputs) {
    const [outL, outR] = outputs[0];
    const n = outL.length;
    if (!this.started && this.count >= TARGET) this.started = true;
    if (!this.started || this.count < n) {
      outL.fill(0);
      if (outR) outR.fill(0);
      if (this.count < n) this.started = false;
      return true;
    }
    for (let i = 0; i < n; i++) {
      outL[i] = this.left[this.read];
      if (outR) outR[i] = this.right[this.read];
      this.read = (this.read + 1) % this.size;
    }
    this.count -= n;
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
