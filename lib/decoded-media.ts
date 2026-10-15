/** A sample-addressed transport for browsers with inaccurate compressed-media seeking. */
export class DecodedMedia extends EventTarget {
  paused = true;
  ended = false;
  seeking = false;
  muted = false;
  playbackRate = 1;
  error: Error | null = null;
  private offset = 0;
  private startedAt = 0;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode;

  constructor(private context: AudioContext, private buffer: AudioBuffer | null, readonly src: string) {
    super();
    this.gain = context.createGain();
    this.gain.connect(context.destination);
  }
  get currentSrc() { return this.src; }
  get duration() { return this.buffer?.duration || 0; }
  get currentTime() {
    return Math.min(this.duration, this.offset + (this.paused ? 0 : (this.context.currentTime - this.startedAt) * this.playbackRate));
  }
  set currentTime(value: number) {
    const resume = !this.paused;
    this.pause();
    this.offset = Math.min(this.duration, Math.max(0, value));
    this.ended = false;
    this.dispatchEvent(new Event('seeking'));
    this.dispatchEvent(new Event('timeupdate'));
    this.dispatchEvent(new Event('seeked'));
    if (resume) void this.play();
  }
  get volume() { return this.gain.gain.value; }
  set volume(value: number) {
    this.gain.gain.value = value;
    this.dispatchEvent(new Event('volumechange'));
  }
  async play() {
    if (!this.buffer) throw new DOMException('Player was released', 'AbortError');
    await this.context.resume();
    if (!this.buffer) throw new DOMException('Player was released', 'AbortError');
    if (!this.paused) return;
    if (this.offset >= this.duration) this.offset = 0;
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.playbackRate;
    source.connect(this.gain);
    source.onended = () => {
      if (this.source !== source) return;
      this.offset = this.duration;
      this.paused = true;
      this.ended = true;
      this.source = null;
      source.disconnect();
      this.dispatchEvent(new Event('timeupdate'));
      this.dispatchEvent(new Event('pause'));
      this.dispatchEvent(new Event('ended'));
    };
    this.source = source;
    this.startedAt = this.context.currentTime;
    this.paused = false;
    this.ended = false;
    source.start(0, this.offset);
    this.dispatchEvent(new Event('play'));
  }
  pause() {
    if (this.paused) return;
    this.offset = this.currentTime;
    this.paused = true;
    const source = this.source;
    this.source = null;
    if (source) { source.onended = null; source.stop(); source.disconnect(); }
    this.dispatchEvent(new Event('pause'));
  }
  destroy() {
    this.pause();
    this.buffer = null;
    this.gain.disconnect();
    void this.context.close().catch(() => undefined);
  }
}
