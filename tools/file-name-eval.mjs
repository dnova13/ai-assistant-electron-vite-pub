// 같은 가짜 이름 자료로 두 방식을 평가한다. 실제 파일·설정·.env는 읽지 않는다.
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { transformWithEsbuild } from 'vite';

const cases = JSON.parse(await fs.readFile(new URL('../test/fixtures/file-name-cases.json', import.meta.url), 'utf8'));
const source = new URL('../src/main/tools/local-name-matcher.ts', import.meta.url);
const { code } = await transformWithEsbuild(await fs.readFile(source, 'utf8'), source.pathname, { loader: 'ts', target: 'node22', format: 'esm' });
const linked = code.replace(/(['"])(es-hangul|cmu-pronouncing-dictionary)\1/g, (_, quote, name) => JSON.stringify(import.meta.resolve(name)));
const { matchLocalFileNames } = await import('data:text/javascript;base64,' + Buffer.from(linked).toString('base64'));
const inputs = cases.map((c) => ({ ...c, candidates: c.names.map((name, i) => ({ id: `c${i + 1}`, name })) }));
const same = (a, b) => [...a].sort().join(',') === [...b].sort().join(',');
const percentile = (values, rate) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * rate) - 1)];
const ms = (value) => Number(value.toFixed(3));

async function evaluate(label, match, rounds) {
  const times = [];
  const failures = [];
  let correct = 0, tp = 0, fp = 0, fn = 0;
  const t0 = performance.now();
  await match(inputs[0].query, inputs[0].candidates);
  const firstMs = ms(performance.now() - t0);
  for (let round = 0; round < rounds; round++) {
    for (const c of inputs) {
      const start = performance.now();
      const got = await match(c.query, c.candidates);
      times.push(performance.now() - start);
      if (round) continue;
      if (same(got, c.want)) correct++;
      else failures.push({ query: c.query, names: c.names, want: c.want, got });
      tp += got.filter((id) => c.want.includes(id)).length;
      fp += got.filter((id) => !c.want.includes(id)).length;
      fn += c.want.filter((id) => !got.includes(id)).length;
    }
  }
  const result = { label, correct, total: inputs.length, precision: tp / (tp + fp || 1), recall: tp / (tp + fn || 1), firstMs, p50Ms: ms(percentile(times, 0.5)), p95Ms: ms(percentile(times, 0.95)), requests: times.length, failures };
  console.log(`${label}: 정답 ${correct}/${inputs.length}, 첫 호출 ${firstMs}ms, p50 ${result.p50Ms}ms, p95 ${result.p95Ms}ms`);
  for (const failure of failures) console.log(`  불일치: ${failure.query} / ${failure.names.join(' | ')} → ${failure.got.join(', ') || '없음'} (기대 ${failure.want.join(', ') || '없음'})`);
  return result;
}

const results = [await evaluate('이 컴퓨터', matchLocalFileNames, 20)];
// 실제 후보 수 상한에서 캐시가 찬 경우도 별도로 잰다. 디스크 탐색 시간은 포함하지 않는다.
const many = Array.from({ length: 128 }, (_, i) => ({ id: `c${i}`, name: `My Music ${i}` }));
await matchLocalFileNames('마이 뮤직', many);
const manyStart = performance.now();
await matchLocalFileNames('마이 뮤직', many);
console.log(`128개 후보, 캐시 사용: ${ms(performance.now() - manyStart)}ms (파일 탐색 제외)`);

if (process.argv.includes('--ai')) {
  const base = process.env.FILE_NAME_EVAL_URL;
  const key = process.env.FILE_NAME_EVAL_KEY;
  if (!base || !key) {
    console.log('AI 미실행: FILE_NAME_EVAL_URL과 FILE_NAME_EVAL_KEY 환경변수가 필요합니다. .env는 자동으로 읽지 않습니다.');
    process.exitCode = 1;
  } else {
    const url = new URL(base);
    url.pathname = url.pathname.replace(/\/$/, '').replace(/\/v1$/, '') + '/v1/files/match';
    url.search = ''; url.hash = '';
    try {
      const ai = await evaluate('AI 비서', async (query, candidates) => {
        const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, candidates }), signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error('연결 실패');
        const { ids } = await response.json();
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !candidates.some((c) => c.id === id)) || new Set(ids).size !== ids.length) throw new Error('응답 오류');
        return ids;
      }, 1); // GPU에 요청을 쌓지 않고 하나씩 보낸다.
      results.push(ai);
    } catch {
      console.log('AI 연결·응답 오류로 비교를 중단했습니다. 주소·키·응답 원문은 출력하지 않습니다.');
      process.exitCode = 1;
    }
  }
} else console.log('AI 비서: 미측정 (--ai로 같은 자료를 순차 비교할 수 있습니다).');

const output = process.argv.indexOf('--json');
if (output !== -1) {
  if (!process.argv[output + 1]) throw new Error('결과 파일 경로가 필요합니다.');
  await fs.writeFile(process.argv[output + 1], JSON.stringify({ measuredAt: new Date().toISOString(), platform: process.platform, note: '가짜 이름 비교만 측정. 음성 인식·분류·파일 탐색·실행 제외.', results }, null, 2) + '\n');
}
