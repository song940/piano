const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B', 'C'];
const KEY_BINDINGS = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k'];
const BLACK_NOTES = new Set([1, 3, 6, 8, 10]);
const DRUMS = [
  { id: 'kick', name: 'KICK', key: '1', color: '#f2834b' },
  { id: 'snare', name: 'SNARE', key: '2', color: '#d276a3' },
  { id: 'hat', name: 'HI-HAT', key: '3', color: '#c7f36b' },
  { id: 'clap', name: 'CLAP', key: '4', color: '#5ad1c7' },
  { id: 'tom', name: 'TOM', key: '5', color: '#8f83e6' },
  { id: 'rim', name: 'RIM', key: '6', color: '#e9d36a' },
  { id: 'shaker', name: 'SHAKER', key: '7', color: '#79c9ef' },
  { id: 'cowbell', name: 'COWBELL', key: '8', color: '#e5966f' },
];
const PRESETS = {
  piano: { wave: 'triangle', attack: .015, release: .7, harmonics: [[1, .72], [2, .18], [3, .08], [4, .035]] },
  warm: { wave: 'sawtooth', attack: .35, release: 1.5, harmonics: [[1, .34], [.502, .18], [1.003, .18]] },
  bass: { wave: 'square', attack: .01, release: .22, harmonics: [[.5, .45], [1, .3]] },
  pluck: { wave: 'triangle', attack: .005, release: .18, harmonics: [[1, .75], [2.01, .15]] },
  raw: { wave: null, attack: null, release: null, harmonics: [[1, .72]] },
};

class AudioEngine {
  constructor() {
    this.context = null;
    this.voices = new Map();
    this.micStream = null;
    this.micSource = null;
    this.mediaRecorder = null;
    this.recordedBlob = null;
    this.recordedBuffer = null;
    this.playback = null;
    this.effectEnabled = { filter: true, drive: true, delay: true, reverb: true };
  }

  async init() {
    if (!this.context) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) throw new Error('当前浏览器不支持 Web Audio API');
      this.context = new AudioCtx();
      const ctx = this.context;
      this.input = ctx.createGain();
      this.filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 12000, Q: 1 });
      this.drive = new WaveShaperNode(ctx, { curve: this.makeDriveCurve(8), oversample: '4x' });
      this.dry = ctx.createGain();
      this.delay = new DelayNode(ctx, { maxDelayTime: 1, delayTime: .18 });
      this.delayGain = new GainNode(ctx, { gain: .22 });
      this.feedback = new GainNode(ctx, { gain: .22 });
      this.convolver = new ConvolverNode(ctx, { buffer: this.makeImpulse(2.2, 2.4) });
      this.reverbGain = new GainNode(ctx, { gain: .18 });
      this.master = new GainNode(ctx, { gain: .75 });
      this.compressor = new DynamicsCompressorNode(ctx, { threshold: -12, knee: 18, ratio: 4, attack: .004, release: .24 });
      this.analyser = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: .82 });
      this.recordDestination = ctx.createMediaStreamDestination();

      this.input.connect(this.filter).connect(this.drive);
      this.drive.connect(this.dry).connect(this.master);
      this.drive.connect(this.delay).connect(this.delayGain).connect(this.master);
      this.delay.connect(this.feedback).connect(this.delay);
      this.drive.connect(this.convolver).connect(this.reverbGain).connect(this.master);
      this.master.connect(this.compressor).connect(this.analyser);
      this.analyser.connect(ctx.destination);
      this.analyser.connect(this.recordDestination);
      this.setEffect('filter', true);
      this.setEffect('drive', true);
      updateEngineState(true);
      drawScope();
    }
    if (this.context.state === 'suspended') await this.context.resume();
    return this.context;
  }

  makeDriveCurve(amount) {
    const length = 4096;
    const curve = new Float32Array(length);
    const k = amount * 4;
    for (let i = 0; i < length; i++) {
      const x = i * 2 / length - 1;
      curve[i] = amount ? ((3 + k) * x * 20 * Math.PI / 180) / (Math.PI + k * Math.abs(x)) : x;
    }
    return curve;
  }

  makeImpulse(seconds, decay) {
    const rate = this.context.sampleRate;
    const impulse = this.context.createBuffer(2, rate * seconds, rate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, decay);
    }
    return impulse;
  }

  setEffect(name, enabled) {
    this.effectEnabled[name] = enabled;
    if (!this.context) return;
    const now = this.context.currentTime;
    if (name === 'filter') this.filter.frequency.setTargetAtTime(enabled ? +$('#filter').value : 20000, now, .01);
    if (name === 'drive') this.drive.curve = this.makeDriveCurve(enabled ? +$('#drive').value : 0);
    if (name === 'delay') this.delayGain.gain.setTargetAtTime(enabled ? +$('#feedback').value : 0, now, .01);
    if (name === 'reverb') this.reverbGain.gain.setTargetAtTime(enabled ? +$('#reverb').value : 0, now, .01);
  }

  frequency(noteIndex, octave) {
    const midi = 12 * (+octave + 1) + noteIndex;
    return 440 * 2 ** ((midi - 69) / 12);
  }

  async noteOn(id, noteIndex) {
    await this.init();
    if (this.voices.has(id)) return;
    const ctx = this.context;
    const preset = PRESETS[$('#preset').value];
    const wave = preset.wave || $('#waveform').value;
    const attack = preset.attack ?? +$('#attack').value;
    const release = preset.release ?? +$('#release').value;
    const frequency = this.frequency(noteIndex, $('#octave').value);
    const voiceGain = new GainNode(ctx, { gain: .0001 });
    const oscillators = preset.harmonics.map(([ratio, level], index) => {
      const oscillator = new OscillatorNode(ctx, { type: wave, frequency: frequency * ratio, detune: index ? (index % 2 ? -4 : 4) : 0 });
      const harmonicGain = new GainNode(ctx, { gain: level });
      oscillator.connect(harmonicGain).connect(voiceGain);
      oscillator.start();
      return oscillator;
    });
    voiceGain.gain.exponentialRampToValueAtTime(.65, ctx.currentTime + Math.max(.005, attack));
    voiceGain.connect(this.input);
    this.voices.set(id, { oscillators, gain: voiceGain, release });
  }

  noteOff(id) {
    const voice = this.voices.get(id);
    if (!voice || !this.context) return;
    const now = this.context.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setTargetAtTime(.0001, now, Math.max(.015, voice.release / 5));
    voice.oscillators.forEach((oscillator) => oscillator.stop(now + voice.release + .12));
    this.voices.delete(id);
  }

  noiseBuffer(seconds = 1) {
    const length = this.context.sampleRate * seconds;
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  async drum(type, when = 0) {
    await this.init();
    const ctx = this.context;
    const start = when || ctx.currentTime;
    if (type === 'kick') {
      const osc = new OscillatorNode(ctx, { type: 'sine', frequency: 150 });
      const gain = new GainNode(ctx, { gain: 1 });
      osc.frequency.exponentialRampToValueAtTime(43, start + .17);
      gain.gain.exponentialRampToValueAtTime(.001, start + .42);
      osc.connect(gain).connect(this.input); osc.start(start); osc.stop(start + .45);
    } else if (type === 'snare' || type === 'clap' || type === 'rim') {
      const noise = new AudioBufferSourceNode(ctx, { buffer: this.noiseBuffer(.5) });
      const filter = new BiquadFilterNode(ctx, { type: type === 'rim' ? 'bandpass' : 'highpass', frequency: type === 'rim' ? 1500 : 900, Q: 1.4 });
      const gain = new GainNode(ctx, { gain: type === 'clap' ? .62 : .55 });
      gain.gain.exponentialRampToValueAtTime(.001, start + (type === 'clap' ? .34 : .18));
      noise.connect(filter).connect(gain).connect(this.input); noise.start(start); noise.stop(start + .4);
      if (type === 'snare' || type === 'rim') this.tone(type === 'rim' ? 520 : 180, .12, 'triangle', start, .18);
    } else if (type === 'hat' || type === 'shaker') {
      const noise = new AudioBufferSourceNode(ctx, { buffer: this.noiseBuffer(.28) });
      const filter = new BiquadFilterNode(ctx, { type: 'highpass', frequency: type === 'hat' ? 6500 : 4300 });
      const gain = new GainNode(ctx, { gain: .32 });
      gain.gain.exponentialRampToValueAtTime(.001, start + (type === 'hat' ? .08 : .2));
      noise.connect(filter).connect(gain).connect(this.input); noise.start(start); noise.stop(start + .25);
    } else if (type === 'tom') {
      this.tone(120, .3, 'sine', start, .65, 68);
    } else if (type === 'cowbell') {
      this.tone(540, .16, 'square', start, .24); this.tone(800, .13, 'square', start, .15);
    }
  }

  tone(frequency, duration, type, start, volume, endFrequency) {
    const osc = new OscillatorNode(this.context, { type, frequency });
    const gain = new GainNode(this.context, { gain: volume });
    if (endFrequency) osc.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
    gain.gain.exponentialRampToValueAtTime(.001, start + duration);
    osc.connect(gain).connect(this.input); osc.start(start); osc.stop(start + duration + .03);
  }

  async toggleMicrophone() {
    await this.init();
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micSource.disconnect(); this.micStream = null; this.micSource = null;
      return false;
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('此浏览器无法访问麦克风');
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    this.micSource = this.context.createMediaStreamSource(this.micStream);
    this.micSource.connect(this.input);
    this.updateMonitoring();
    return true;
  }

  updateMonitoring() {
    if (!this.context) return;
    const shouldMonitor = !this.micStream || $('#mic-monitor').checked;
    try { this.analyser.disconnect(this.context.destination); } catch (_) {}
    if (shouldMonitor) this.analyser.connect(this.context.destination);
  }

  async startRecording(onData) {
    await this.init();
    if (!window.MediaRecorder) throw new Error('当前浏览器不支持实时录音');
    const mimeTypes = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
    const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
    const chunks = [];
    this.mediaRecorder = new MediaRecorder(this.recordDestination.stream, mimeType ? { mimeType } : undefined);
    this.mediaRecorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    this.mediaRecorder.onstop = async () => {
      this.recordedBlob = new Blob(chunks, { type: this.mediaRecorder.mimeType });
      const arrayBuffer = await this.recordedBlob.arrayBuffer();
      try { this.recordedBuffer = await this.context.decodeAudioData(arrayBuffer.slice(0)); }
      catch (_) { this.recordedBuffer = null; }
      onData(this.recordedBlob, this.recordedBuffer);
    };
    this.mediaRecorder.start(100);
  }

  stopRecording() { if (this.mediaRecorder?.state === 'recording') this.mediaRecorder.stop(); }
  playRecording(onEnded) {
    if (!this.recordedBuffer) return false;
    this.stopPlayback();
    this.playback = new AudioBufferSourceNode(this.context, { buffer: this.recordedBuffer });
    this.playback.connect(this.context.destination);
    this.playback.onended = () => { this.playback = null; onEnded?.(); };
    this.playback.start(); return true;
  }
  stopPlayback() { if (this.playback) { try { this.playback.stop(); } catch (_) {} this.playback = null; } }
  clearRecording() { this.stopPlayback(); this.recordedBlob = null; this.recordedBuffer = null; }
}

const engine = new AudioEngine();
let loopTimer = null;
let loopStep = 0;
let sequence = Array(16).fill(null);
let recordStarted = 0;
let recordTimer = null;
let toastTimer = null;

function updateEngineState(live) {
  $('.engine-state').classList.toggle('live', live);
  $('#engine-label').textContent = live ? `音频引擎运行中 · ${engine.context.sampleRate / 1000} kHz` : '点击任意乐器启动音频';
}

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

function buildKeyboard() {
  const keyboard = $('#keyboard');
  NOTE_NAMES.forEach((name, index) => {
    if (BLACK_NOTES.has(index)) return;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'key'; button.dataset.note = index;
    button.innerHTML = `<span>${name}<br>${KEY_BINDINGS[index].toUpperCase()}</span>`;
    bindKey(button, index); keyboard.append(button);
  });
  const whitePositions = { 1: 1, 3: 2, 6: 4, 8: 5, 10: 6 };
  Object.entries(whitePositions).forEach(([note, position]) => {
    const index = +note; const button = document.createElement('button'); button.type = 'button'; button.className = 'key black'; button.dataset.note = index;
    button.style.left = `${position / 8 * 100}%`; button.innerHTML = `<span>${KEY_BINDINGS[index].toUpperCase()}</span>`;
    bindKey(button, index); keyboard.append(button);
  });
}

function bindKey(button, note) {
  const id = `pointer-${note}`;
  const start = async (event) => { event.preventDefault(); button.setPointerCapture?.(event.pointerId); button.classList.add('active'); await engine.noteOn(id, note); };
  const end = () => { button.classList.remove('active'); engine.noteOff(id); };
  button.addEventListener('pointerdown', start); button.addEventListener('pointerup', end); button.addEventListener('pointercancel', end); button.addEventListener('pointerleave', (event) => { if (event.buttons) end(); });
}

function buildDrums() {
  DRUMS.forEach((drum) => {
    const pad = document.createElement('button'); pad.type = 'button'; pad.className = 'drum-pad'; pad.dataset.drum = drum.id; pad.style.setProperty('--pad-color', drum.color);
    pad.innerHTML = `<i></i><strong>${drum.name}</strong><small>KEY ${drum.key}</small>`;
    pad.addEventListener('pointerdown', () => hitDrum(drum.id)); $('#drum-grid').append(pad);
  });
  sequence.forEach((_, index) => {
    const step = document.createElement('button'); step.type = 'button'; step.className = 'step'; step.dataset.index = index; step.title = `Step ${index + 1}: 空`;
    step.addEventListener('click', () => { const current = sequence[index] ? DRUMS.findIndex((drum) => drum.id === sequence[index]) + 1 : 0; const next = current > 4 ? 0 : current; sequence[index] = next ? DRUMS[next - 1].id : DRUMS[0].id; if (current > 0) sequence[index] = current === 4 ? null : DRUMS[current].id; renderSequence(); });
    $('#sequencer').append(step);
  });
  renderSequence();
}

function hitDrum(id, scheduled = false) {
  engine.drum(id);
  if (!scheduled) {
    const pad = $(`[data-drum="${id}"]`); pad?.classList.add('hit'); setTimeout(() => pad?.classList.remove('hit'), 100);
  }
}

function renderSequence() {
  $$('.step').forEach((step, index) => { const drum = DRUMS.find((item) => item.id === sequence[index]); step.classList.toggle('on', !!drum); step.style.setProperty('--acid', drum?.color || '#c7f36b'); step.title = `Step ${index + 1}: ${drum?.name || '空'}`; });
}

function startLoop() {
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; loopStep = 0; $$('.step').forEach((step) => step.classList.remove('playing')); $('#loop-toggle').textContent = '播放循环'; return; }
  engine.init(); $('#loop-toggle').textContent = '停止循环';
  const tick = () => { $$('.step').forEach((step, index) => step.classList.toggle('playing', index === loopStep)); if (sequence[loopStep]) hitDrum(sequence[loopStep], true); loopStep = (loopStep + 1) % 16; };
  tick(); loopTimer = setInterval(tick, 60000 / +$('#bpm').value / 4);
}

function bindControls() {
  $$('[data-source-tab]').forEach((tab) => tab.addEventListener('click', () => { $$('[data-source-tab]').forEach((item) => item.classList.toggle('active', item === tab)); $$('[data-source-view]').forEach((view) => view.classList.toggle('active', view.dataset.sourceView === tab.dataset.sourceTab)); }));
  const rangeBindings = [
    ['attack', (v) => `${(+v).toFixed(2)}s`], ['release', (v) => `${(+v).toFixed(2)}s`],
    ['filter', (v) => +v >= 1000 ? `${(+v / 1000).toFixed(1)} kHz` : `${v} Hz`], ['resonance', (v) => (+v).toFixed(1)],
    ['drive', (v) => `${v}%`], ['delay', (v) => `${Math.round(v * 1000)} ms`], ['feedback', (v) => `${Math.round(v * 100)}%`],
    ['reverb', (v) => `${Math.round(v * 100)}%`], ['volume', (v) => `${Math.round(v * 100)}%`], ['bpm', (v) => v],
  ];
  rangeBindings.forEach(([id, format]) => $(`#${id}`).addEventListener('input', (event) => {
    $(`#${id}-value`).textContent = format(event.target.value);
    if (!engine.context) return; const value = +event.target.value; const now = engine.context.currentTime;
    if (id === 'filter' && engine.effectEnabled.filter) engine.filter.frequency.setTargetAtTime(value, now, .01);
    if (id === 'resonance') engine.filter.Q.setTargetAtTime(value, now, .01);
    if (id === 'drive' && engine.effectEnabled.drive) engine.drive.curve = engine.makeDriveCurve(value);
    if (id === 'delay') engine.delay.delayTime.setTargetAtTime(value, now, .01);
    if (id === 'feedback') { engine.feedback.gain.setTargetAtTime(value, now, .01); if (engine.effectEnabled.delay) engine.delayGain.gain.setTargetAtTime(value, now, .01); }
    if (id === 'reverb' && engine.effectEnabled.reverb) engine.reverbGain.gain.setTargetAtTime(value, now, .01);
    if (id === 'volume') engine.master.gain.setTargetAtTime(value, now, .01);
    if (id === 'bpm' && loopTimer) { startLoop(); startLoop(); }
  }));
  $$('.effect').forEach((effect) => effect.querySelector('.effect-title button').addEventListener('click', () => { const enabled = !effect.classList.contains('active'); effect.classList.toggle('active', enabled); engine.setEffect(effect.dataset.effect, enabled); }));
  $('#bypass').addEventListener('click', () => { const turnOn = $('#bypass').classList.contains('off'); $('#bypass').classList.toggle('off', !turnOn); $('#bypass').textContent = turnOn ? 'FX ON' : 'BYPASS'; $$('.effect').forEach((effect) => { effect.classList.toggle('active', turnOn); engine.setEffect(effect.dataset.effect, turnOn); }); });
  $('#preset').addEventListener('change', (event) => { const preset = PRESETS[event.target.value]; if (preset.wave) $('#waveform').value = preset.wave; if (preset.attack != null) { $('#attack').value = preset.attack; $('#attack').dispatchEvent(new Event('input')); } if (preset.release != null) { $('#release').value = preset.release; $('#release').dispatchEvent(new Event('input')); } });
  $('#loop-toggle').addEventListener('click', startLoop); $('#loop-clear').addEventListener('click', () => { sequence.fill(null); renderSequence(); });
  $('#mic-toggle').addEventListener('click', async () => { try { const live = await engine.toggleMicrophone(); $('.mic-view').classList.toggle('live', live); $('#mic-toggle').textContent = live ? '关闭麦克风' : '启用麦克风'; toast(live ? '麦克风已接入效果链' : '麦克风已关闭'); } catch (error) { toast(error.message); } });
  $('#mic-monitor').addEventListener('change', () => engine.updateMonitoring());
  $('#record').addEventListener('click', toggleRecording); $('#play').addEventListener('click', playRecording); $('#stop').addEventListener('click', stopTransport); $('#clear-recording').addEventListener('click', clearRecording); $('#export-wav').addEventListener('click', exportWav);
}

async function toggleRecording() {
  if (engine.mediaRecorder?.state === 'recording') { engine.stopRecording(); setRecordingUI(false); return; }
  try {
    await engine.startRecording((blob, buffer) => {
      if (!buffer) { $('#export-description').textContent = `已录制 ${(blob.size / 1024).toFixed(0)} KB；此浏览器暂不能解码为 WAV`; toast('录音完成，但当前浏览器无法生成 WAV'); return; }
      const duration = buffer.duration; $('#recording-status').textContent = '录音已就绪'; $('#recording-time').textContent = formatTime(duration); $('#export-description').textContent = `${duration.toFixed(1)} 秒 · ${buffer.sampleRate / 1000} kHz · ${buffer.numberOfChannels} 声道`;
      $('#play').disabled = false; $('#clear-recording').disabled = false; $('#export-wav').disabled = false; buildMiniWave(buffer); toast('录音完成');
    });
    setRecordingUI(true); recordStarted = performance.now(); recordTimer = setInterval(() => $('#recording-time').textContent = formatTime((performance.now() - recordStarted) / 1000), 100);
  } catch (error) { toast(error.message); }
}

function setRecordingUI(recording) {
  $('#record').classList.toggle('recording', recording); $('#record span').textContent = recording ? '结束录音' : '开始录音'; $('#recording-status').textContent = recording ? '正在录制效果链输出' : '正在处理录音…'; $('#stop').disabled = !recording; $('#play').disabled = recording || !engine.recordedBuffer;
  if (!recording) { clearInterval(recordTimer); recordTimer = null; }
}
function playRecording() { if (engine.playRecording(() => { $('#play').disabled = false; $('#stop').disabled = true; })) { $('#play').disabled = true; $('#stop').disabled = false; $('#recording-status').textContent = '正在播放'; } }
function stopTransport() { if (engine.mediaRecorder?.state === 'recording') { engine.stopRecording(); setRecordingUI(false); } engine.stopPlayback(); $('#play').disabled = !engine.recordedBuffer; $('#stop').disabled = true; if (engine.recordedBuffer) $('#recording-status').textContent = '录音已就绪'; }
function clearRecording() { engine.clearRecording(); $('#play').disabled = $('#stop').disabled = $('#clear-recording').disabled = $('#export-wav').disabled = true; $('#recording-status').textContent = '等待录音'; $('#recording-time').textContent = '00:00.0'; $('#export-description').textContent = '完成一段录音后可导出 WAV'; $('#mini-wave').innerHTML = ''; }
function formatTime(seconds) { const minutes = Math.floor(seconds / 60); return `${String(minutes).padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`; }

function buildMiniWave(buffer) {
  const data = buffer.getChannelData(0); const count = 90; const stride = Math.max(1, Math.floor(data.length / count)); const fragment = document.createDocumentFragment();
  for (let i = 0; i < count; i++) { let peak = 0; for (let j = 0; j < stride; j += 20) peak = Math.max(peak, Math.abs(data[i * stride + j] || 0)); const bar = document.createElement('i'); bar.style.height = `${Math.max(2, peak * 28)}px`; fragment.append(bar); }
  $('#mini-wave').replaceChildren(fragment);
}

function encodeWav(buffer) {
  const channels = buffer.numberOfChannels; const sampleRate = buffer.sampleRate; const samples = buffer.length; const bytesPerSample = 2; const output = new ArrayBuffer(44 + samples * channels * bytesPerSample); const view = new DataView(output);
  const write = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, output.byteLength - 8, true); write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * bytesPerSample, true); view.setUint16(32, channels * bytesPerSample, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, samples * channels * bytesPerSample, true);
  let offset = 44; for (let i = 0; i < samples; i++) for (let channel = 0; channel < channels; channel++) { const sample = clamp(buffer.getChannelData(channel)[i], -1, 1); view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true); offset += 2; }
  return new Blob([output], { type: 'audio/wav' });
}
function exportWav() { if (!engine.recordedBuffer) return; const url = URL.createObjectURL(encodeWav(engine.recordedBuffer)); const link = document.createElement('a'); const stamp = new Date().toISOString().replace(/[:.]/g, '-'); link.href = url; link.download = `audio-lab-${stamp}.wav`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('WAV 已导出'); }

function drawScope() {
  if (!engine.analyser) return; const canvas = $('#scope'); const ctx = canvas.getContext('2d'); const samples = new Uint8Array(engine.analyser.fftSize);
  const draw = () => { requestAnimationFrame(draw); engine.analyser.getByteTimeDomainData(samples); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.strokeStyle = '#c7f36b'; ctx.lineWidth = 2; ctx.beginPath(); let rms = 0; for (let i = 0; i < samples.length; i++) { const normalized = (samples[i] - 128) / 128; rms += normalized * normalized; const x = i / (samples.length - 1) * canvas.width; const y = (normalized * .75 + 1) * canvas.height / 2; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); rms = Math.sqrt(rms / samples.length); $('#scope-level').textContent = rms > .0001 ? `${(20 * Math.log10(rms)).toFixed(1)} dB` : '-∞ dB'; };
  draw();
}

document.addEventListener('keydown', (event) => {
  if (event.repeat || ['INPUT', 'SELECT'].includes(event.target.tagName)) return;
  const key = event.key.toLowerCase(); const note = KEY_BINDINGS.indexOf(key);
  if (note >= 0) { event.preventDefault(); $(`.key[data-note="${note}"]`)?.classList.add('active'); engine.noteOn(`key-${key}`, note); }
  const drum = DRUMS.find((item) => item.key === event.key); if (drum) hitDrum(drum.id);
});
document.addEventListener('keyup', (event) => { const key = event.key.toLowerCase(); const note = KEY_BINDINGS.indexOf(key); if (note >= 0) { $(`.key[data-note="${note}"]`)?.classList.remove('active'); engine.noteOff(`key-${key}`); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) [...engine.voices.keys()].forEach((id) => engine.noteOff(id)); });

buildKeyboard(); buildDrums(); bindControls();
