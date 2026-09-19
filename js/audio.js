// ============================================================
//  音声エンジン（Web Audio API）
//
//  遅延を最小にするための方針
//   1. 取り込み時に音声を「デコード済み」にしておく
//      - 短い音 → AudioBuffer（PCM）としてメモリ常駐。start() で即発音
//      - 長い音 → <audio> を preload 済みにして待機（メモリ節約）
//   2. AudioContext は latencyHint:"interactive" で生成
//   3. 最初の操作時に resume() ＋ 無音を 1 回鳴らして経路を温める
//
//  信号の流れ
//      音源 ─> voiceGain（曲ごとの音量／フェード）
//                 ─> groupGain（リストごとの音量）
//                      ─> master ─> スピーカー
// ============================================================

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.groups = new Map();   // listId -> GainNode
    this.loaded = new Map();   // cueId -> { mode, buffer|el, node, gain, duration }
    this.voices = new Map();   // voiceId -> voice
    this.seq = 0;
    this.onChange = () => {};
  }

  // ---------- 初期化 ----------
  init() {
    if (this.ctx) return this.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: "interactive" });
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  /** 最初のユーザー操作で呼ぶ。出力経路を起こして温める。 */
  async unlock() {
    this.init();
    if (this.ctx.state !== "running") {
      try { await this.ctx.resume(); } catch { /* 無視 */ }
    }
    try {
      const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const s = this.ctx.createBufferSource();
      s.buffer = b;
      s.connect(this.master);
      s.start(0);
    } catch { /* 無視 */ }
  }

  get outputLatencyMs() {
    if (!this.ctx) return null;
    return Math.round(((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000);
  }

  // ---------- リスト（グループ）ごとの音量 ----------
  group(listId) {
    this.init();
    const key = listId || "default";
    let g = this.groups.get(key);
    if (!g) {
      g = this.ctx.createGain();
      g.gain.value = 1;
      g.connect(this.master);
      this.groups.set(key, g);
    }
    return g;
  }

  setGroupVolume(listId, v) {
    const g = this.group(listId).gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(clamp(v, 0, 1.5), now, 0.01);
  }

  /** キューを別のリストへ移したときに、ストリーム音源の接続先を張り替える */
  setCueGroup(cueId, listId) {
    const l = this.loaded.get(cueId);
    if (!l || l.mode !== "stream") return;
    try { l.gain.disconnect(); } catch { /* 無視 */ }
    l.gain.connect(this.group(listId));
  }

  // ---------- 読み込み ----------
  async prepare(cue, blob, thresholdSec) {
    this.init();
    this.unload(cue.id);

    const probeUrl = URL.createObjectURL(blob);
    let duration = await probeDuration(probeUrl);

    let mode = cue.mode && cue.mode !== "auto" ? cue.mode : null;
    if (!mode) {
      mode = !Number.isFinite(duration) || duration <= thresholdSec ? "buffer" : "stream";
    }

    if (mode === "buffer") {
      URL.revokeObjectURL(probeUrl);
      const ab = await blob.arrayBuffer();
      const buffer = await this.ctx.decodeAudioData(ab);
      duration = buffer.duration;
      const bytes = buffer.length * buffer.numberOfChannels * 4;
      this.loaded.set(cue.id, { mode: "buffer", buffer, duration, bytes });
      return { mode: "buffer", duration, bytes };
    }

    // ストリーミング：要素を作って最後まで先読みさせておく
    const el = new Audio();
    el.src = probeUrl;
    el.preload = "auto";
    const node = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();
    node.connect(gain);
    gain.connect(this.group(cue.listId));
    el.load();
    el.addEventListener("ended", () => {
      for (const [vid, v] of this.voices) if (v.cueId === cue.id) this._drop(vid);
    });
    this.loaded.set(cue.id, { mode: "stream", el, node, gain, url: probeUrl, duration, bytes: 0 });
    await waitCanPlayThrough(el);
    return { mode: "stream", duration: Number.isFinite(el.duration) ? el.duration : duration, bytes: 0 };
  }

  unload(cueId) {
    this.stopCue(cueId, 0);
    const l = this.loaded.get(cueId);
    if (!l) return;
    if (l.mode === "stream") {
      try { l.el.pause(); l.node.disconnect(); l.gain.disconnect(); } catch { /* 無視 */ }
      if (l.url) URL.revokeObjectURL(l.url);
    }
    this.loaded.delete(cueId);
  }

  isReady(cueId) { return this.loaded.has(cueId); }
  info(cueId) { return this.loaded.get(cueId) || null; }

  memoryBytes() {
    let n = 0;
    for (const l of this.loaded.values()) n += l.bytes || 0;
    return n;
  }

  // ---------- 再生 ----------
  /**
   * @param cue  キュー（listId / volume / fadeIn / fadeOut / startSec / endSec を見る）
   * @param opts {ignoreTrim:bool, offset:number|null, noFade:bool}
   *             試聴では ignoreTrim:true, noFade:true で丸ごと鳴らす
   * @returns voiceId または null
   */
  play(cue, opts = {}) {
    const l = this.loaded.get(cue.id);
    if (!l) return null;
    this.init();
    const ctx = this.ctx;
    if (ctx.state !== "running") ctx.resume();

    const now = ctx.currentTime;
    const vol = clamp(cue.volume ?? 1, 0, 1.5);
    const useTrim = !opts.ignoreTrim;
    const total = l.duration || 0;

    const start = clampNum(
      opts.offset != null ? opts.offset : (useTrim ? (cue.startSec || 0) : 0),
      0, Math.max(0, total - 0.05));
    const endRaw = useTrim && cue.endSec ? cue.endSec : null;
    const playEnd = endRaw != null ? Math.min(endRaw, total || endRaw) : total;
    const playLen = playEnd > start ? playEnd - start : null;   // null = 最後まで

    const fadeIn = opts.noFade ? 0 : Math.max(0, cue.fadeIn ?? 0);
    // 終了位置を指定したときだけ、その手前で自動フェードアウトする
    const autoFadeOut = (!opts.noFade && endRaw != null && playLen)
      ? Math.min(Math.max(0, cue.fadeOut ?? 0), playLen * 0.9) : 0;

    const id = "v" + ++this.seq;
    const timers = [];

    if (l.mode === "buffer") {
      const src = ctx.createBufferSource();
      src.buffer = l.buffer;
      const gain = ctx.createGain();
      src.connect(gain);
      gain.connect(this.group(cue.listId));
      applyEnvelope(gain.gain, now, vol, fadeIn, playLen, autoFadeOut);
      if (playLen != null) src.start(now, start, playLen);
      else src.start(now, start);          // ← ここが「押した瞬間に鳴る」部分
      const voice = {
        id, cueId: cue.id, listId: cue.listId, kind: "buffer", src, gain,
        startedAt: now, startOffset: start, playEnd: playEnd || total, timers,
      };
      src.onended = () => this._drop(id);
      this.voices.set(id, voice);
    } else {
      // ストリーミングは 1 キューにつき 1 音（BGM 用途）
      this.stopCue(cue.id, 0);
      l.gen = (l.gen || 0) + 1;      // 古いフェードアウトの後始末が
      const gain = l.gain;           // この再生を止めないようにする印
      applyEnvelope(gain.gain, now, vol, fadeIn, playLen, autoFadeOut);
      try { l.el.currentTime = start; } catch { /* 無視 */ }
      const p = l.el.play();
      if (p && p.catch) p.catch(() => {});
      const voice = {
        id, cueId: cue.id, listId: cue.listId, kind: "stream", el: l.el, gain, gen: l.gen,
        startedAt: now, startOffset: start, playEnd: playEnd || total, timers,
      };
      if (playLen != null && endRaw != null) {
        timers.push(setTimeout(() => {
          if (this.voices.get(id) === voice) {
            try { l.el.pause(); l.el.currentTime = start; } catch { /* 無視 */ }
            this._drop(id);
          }
        }, playLen * 1000 + 20));
      }
      this.voices.set(id, voice);
    }
    this.onChange();
    return id;
  }

  /** 1 音を止める。fadeSec 秒かけて消す。 */
  stopVoice(voiceId, fadeSec = 0) {
    const v = this.voices.get(voiceId);
    if (!v || v.stopping) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const g = v.gain.gain;
    const f = Math.max(0, fadeSec);
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(Math.max(g.value, 0.0001), now);
      if (f > 0) g.linearRampToValueAtTime(0.0001, now + f);
      else g.setValueAtTime(0.0001, now);
    } catch { /* 無視 */ }

    v.stopping = true;
    for (const t of v.timers) clearTimeout(t);
    v.timers.length = 0;

    const finish = () => {
      if (v.kind === "buffer") {
        try { v.src.stop(); } catch { /* 無視 */ }
      } else {
        // すでに同じキューが再生し直されていたら、止めずに抜ける
        const l = this.loaded.get(v.cueId);
        if (!l || l.gen === v.gen) {
          try { v.el.pause(); v.el.currentTime = 0; } catch { /* 無視 */ }
        }
      }
      this._drop(voiceId);
    };
    if (f > 0) v.timers.push(setTimeout(finish, f * 1000 + 30));
    else finish();
    this.onChange();
  }

  stopCue(cueId, fadeSec = 0) {
    for (const [id, v] of this.voices) if (v.cueId === cueId && !v.stopping) this.stopVoice(id, fadeSec);
  }

  /** リスト単位の停止 */
  stopList(listId, fadeSec = 0) {
    for (const [id, v] of this.voices) if (v.listId === listId && !v.stopping) this.stopVoice(id, fadeSec);
  }

  stopAll(fadeSec = 0) {
    for (const [id, v] of this.voices) if (!v.stopping) this.stopVoice(id, fadeSec);
  }

  // ---------- 音量 ----------
  setMasterVolume(v) {
    this.init();
    const g = this.master.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(clamp(v, 0, 1), now, 0.01);
  }

  /** 再生中の音にも即座に反映する */
  setCueVolume(cueId, v) {
    const vol = clamp(v, 0, 1.5);
    for (const voice of this.voices.values()) {
      if (voice.cueId !== cueId || voice.stopping) continue;
      const g = voice.gain.gain;
      const now = this.ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setTargetAtTime(Math.max(vol, 0.0001), now, 0.02);
    }
  }

  // ---------- 状態 ----------
  activeVoices() {
    const out = [];
    for (const v of this.voices.values()) {
      if (v.stopping) continue;
      out.push({
        id: v.id, cueId: v.cueId, listId: v.listId,
        position: this.position(v), end: v.playEnd || 0, start: v.startOffset || 0,
      });
    }
    return out;
  }

  position(v) {
    if (!this.ctx) return 0;
    if (v.kind === "buffer") return (v.startOffset || 0) + Math.max(0, this.ctx.currentTime - v.startedAt);
    return v.el.currentTime || 0;
  }

  voicePosition(voiceId) {
    const v = this.voices.get(voiceId);
    return v ? this.position(v) : 0;
  }

  _drop(voiceId) {
    const v = this.voices.get(voiceId);
    if (v) for (const t of v.timers) clearTimeout(t);
    if (this.voices.delete(voiceId)) this.onChange();
  }
}

// ---------- 補助関数 ----------
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function clampNum(n, lo, hi) { return Number.isFinite(n) ? clamp(n, lo, Math.max(lo, hi)) : lo; }

/** フェードイン →（必要なら）終了位置手前でフェードアウト、を一度に予約する */
function applyEnvelope(param, now, vol, fadeIn, playLen, fadeOut) {
  const target = Math.max(vol, 0.0001);
  param.cancelScheduledValues(now);
  if (fadeIn > 0) {
    param.setValueAtTime(0.0001, now);
    param.linearRampToValueAtTime(target, now + fadeIn);
  } else {
    param.setValueAtTime(target, now);
  }
  if (fadeOut > 0 && playLen != null) {
    const foStart = now + playLen - fadeOut;
    if (foStart > now + fadeIn) {
      param.setValueAtTime(target, foStart);
      param.linearRampToValueAtTime(0.0001, now + playLen);
    }
  }
}

function probeDuration(url) {
  return new Promise((resolve) => {
    const el = new Audio();
    const done = (d) => { el.src = ""; resolve(d); };
    el.preload = "metadata";
    el.addEventListener("loadedmetadata", () => done(el.duration), { once: true });
    el.addEventListener("error", () => done(NaN), { once: true });
    setTimeout(() => done(el.duration || NaN), 8000);
    el.src = url;
  });
}

function waitCanPlayThrough(el) {
  return new Promise((resolve) => {
    if (el.readyState >= 4) return resolve();
    const done = () => resolve();
    el.addEventListener("canplaythrough", done, { once: true });
    el.addEventListener("error", done, { once: true });
    setTimeout(done, 20000);
  });
}
