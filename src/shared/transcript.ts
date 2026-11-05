// 받아 적은 글 다듬기: 위스퍼가 조용하거나 잡음뿐인 소리에서 같은 말을 끝없이 반복해 지어내는 것("이곳은 이곳은 …")을 줄인다.
// 메인(음성 인식 결과)과 화면(호출어·이어서 대화의 잡음 판단)이 같이 쓴다.

/** 같은 말이 이만큼 이어서 반복되면 하나로 줄인다 */
const MIN_REPEAT = 3;

/**
 * 반복을 줄인다.
 * - 띄어쓰기 없이 붙은 반복(두 글자 이상 묶음이 두 번 넘게): "이곳은이곳은" → "이곳은"
 * - 한 단어~네 단어 묶음이 3번 넘게 이어지면 한 번만: "어때 어때 어때 어때" → "어때"
 * - 반복을 걷어 내고 나면 거의 남는 게 없는 결과(8단어 넘게 반복됐는데 1~2단어만 남음)는 지어낸 것으로 보고 빈 글로
 */
export function cleanTranscript(raw: string): string {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const glued = text
    .split(' ')
    .map((w) => w.replace(/(\S{2,12}?)\1+/gu, '$1'))
    .filter(Boolean);
  const out: string[] = [];
  let collapsed = 0;
  for (let i = 0; i < glued.length; ) {
    let done = false;
    // 가장 짧은 묶음부터 본다 ("이곳은 이곳은 …"을 네 단어 묶음이 아니라 한 단어 반복으로)
    for (let n = 1; n <= 4 && !done; n++) {
      if (i + n * MIN_REPEAT > glued.length) continue;
      const unit = glued.slice(i, i + n).join(' ');
      let k = 1;
      while (i + (k + 1) * n <= glued.length && glued.slice(i + k * n, i + (k + 1) * n).join(' ') === unit) k++;
      if (k >= MIN_REPEAT) {
        out.push(...glued.slice(i, i + n));
        i += k * n;
        collapsed += (k - 1) * n;
        done = true;
      }
    }
    if (!done) {
      out.push(glued[i]);
      i++;
    }
  }
  if (glued.length >= 8 && out.length <= 2 && collapsed >= 6) return '';
  return out.join(' ');
}

/** 받아 적은 글이 반복으로 지어낸 것으로 보이는지 */
export function isRepetitive(raw: string): boolean {
  const t = String(raw || '').trim();
  return !!t && !cleanTranscript(t);
}

/** 소리 길이(초)에 맞는 최대 글자 조각(토큰) 수. 1초에 15개 + 10, 위스퍼 한 덩어리(30초) 최대 440 */
export function maxTokensFor(seconds: number): number {
  const s = Math.max(0.5, Math.min(30, seconds));
  return Math.min(440, Math.ceil(s * 15) + 10);
}
