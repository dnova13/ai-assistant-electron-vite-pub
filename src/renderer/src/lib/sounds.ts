// 짧은 알림음. 파일 없이 오디오 처리기로 만든다 (끝나면 처리기를 닫는다).

/** 이어서 대화가 끝날 때: 낮아지는 두 음. volume 0~1 (TTS 음량을 따른다) */
export function playEndChime(volume = 1): void {
  tones([
    [880, 0],
    [660, 0.14]
  ], volume);
}

/** 호출어를 들었을 때 (음성 파일·TTS가 없으면): 올라가는 두 음 */
export function playStartChime(volume = 1): void {
  tones([
    [660, 0],
    [990, 0.12]
  ], volume);
}

function tones(list: number[][], volume: number): void {
  const peak = 0.12 * Math.min(1, Math.max(0, volume));
  if (peak < 0.001) return;
  try {
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + 0.02;
    list.forEach(([freq, at]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.2);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.22);
    });
    setTimeout(() => void ctx.close().catch(() => {}), 800);
  } catch {
    /* 소리를 낼 수 없는 환경 */
  }
}
