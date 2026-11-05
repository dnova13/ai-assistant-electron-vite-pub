import { describe, it, expect, vi } from 'vitest';
import { confirmationDecision, decideConfirmation } from '../src/shared/confirmation';
import { ServerTransport } from '../src/main/remote/server-hub';
import * as api from '../src/main/api/client';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('공통 확인 답변', () => {
  it('긍정·부정 전체 표현은 AI 없이 판정한다', async () => {
    const model = vi.fn(async () => 'unknown' as const);
    for (const word of ['예','네','응','어','yes','y','ㅇ','ㅇㅇ',' YES ']) {
      expect(confirmationDecision(word)).toBe('yes');
      expect(await decideConfirmation('복사할까요?', word, model)).toBe('yes');
    }
    for (const word of ['아니오','아니요','아니','no','n','취소','ㄴ','ㄴㄴ',' NO ']) {
      expect(await decideConfirmation('복사할까요?', word, model)).toBe('no');
    }
    expect(model).not.toHaveBeenCalled();
  });
  it('목록 밖의 답은 질문과 함께 판별하고 실패·모호함·중단은 승인하지 않는다', async () => {
    const model = vi.fn(async () => 'yes' as const);
    expect(await decideConfirmation('복사할까요?', '그래 진행해', model)).toBe('yes');
    expect(model).toHaveBeenCalledWith('복사할까요?', '그래 진행해', undefined);
    expect(await decideConfirmation('복사할까요?', '하지 마', async () => 'no')).toBe('no');
    expect(await decideConfirmation('삭제할까요?', '백업했으면', async () => 'unknown')).toBe('unknown');
    expect(await decideConfirmation('삭제할까요?', '그래', async () => { throw Error(); })).toBe('unknown');
    const abort = new AbortController();
    expect(await decideConfirmation('삭제할까요?', '그래', async () => { abort.abort(); return 'yes'; }, abort.signal)).toBe('unknown');
  });
  it('다른 종류의 AI도 일반 대화 기억 없이 판별 JSON만 받는다', async () => {
    const decision = JSON.stringify({ decision: 'yes' });
    const payloads = {
      openai: 'data: ' + JSON.stringify({ choices: [{ delta: { content: decision } }] }) + '\n\ndata: [DONE]\n\n',
      anthropic: 'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: decision } }) + '\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
      gemini: 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: decision }] } }] }) + '\n\n',
      ollama: JSON.stringify({ message: { content: decision }, done: false }) + '\n' + JSON.stringify({ done: true }) + '\n'
    };
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      for (const type of ['openai', 'anthropic', 'gemini', 'ollama'] as const) {
        fetch.mockResolvedValueOnce(new Response(payloads[type], { headers: { 'content-type': type === 'ollama' ? 'application/x-ndjson' : 'text/event-stream' } }));
        expect(await api.interpretConfirmation({ type, baseUrl: 'https://unit.invalid', apiKey: 'qa-only', model: 'gemini-2.5-flash' }, '복사할까요?', '그래 진행해')).toBe('yes');
        const body = String(fetch.mock.calls.at(-1)?.[1]?.body);
        expect(body).toContain('복사할까요?');
        expect(body).toContain('그래 진행해');
      }
    } finally { fetch.mockRestore(); }
  });
  it('내 서버에는 판별 전용 요청만 보내고 잘못된 응답은 승인하지 않는다', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const profile = { type: 'assistant' as const, baseUrl: 'https://unit.invalid/v1', apiKey: '' };
    fetch.mockResolvedValueOnce(Response.json({ decision: 'yes' }));
    expect(await api.interpretConfirmation(profile, '복사할까요?', '그래 진행해')).toBe('yes');
    expect(String(fetch.mock.calls[0][0])).toContain('/confirmation/interpret');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ question: '복사할까요?', answer: '그래 진행해' });
    fetch.mockResolvedValueOnce(Response.json({ decision: true }));
    expect(await api.interpretConfirmation(profile, '복사할까요?', '그래')).toBe('unknown');
    fetch.mockRestore();
  });
});

describe('비서 서버 질문 전송', () => {
  it('불명확한 답 뒤에도 질문 번호·기한을 유지하고 다음 긍정 답을 받는다', async () => {
    const sent: Record<string, any>[] = [];
    const model = vi.fn(async () => 'unknown' as const);
    const t = new ServerTransport(m => sent.push(m), undefined, model);
    let result: string | undefined;
    const done = t.run('first', async () => { result = await t.ask('복사할까요?', '대상: 메모', 3000); });
    await tick();
    const prompt = sent[0].prompt;
    expect(prompt).toMatchObject({ kind: 'confirm', destructive: false });
    t.answer('answer1', '백업했으면 해', prompt.id);
    await tick();
    expect(sent.at(-1)?.prompt).toEqual(prompt);
    expect(sent.at(-1)?.text).toContain('다시 답해');
    t.answer('answer2', '어', prompt.id);
    await done;
    expect(result).toBe('yes');
    expect(model).toHaveBeenCalledTimes(1);
  });
  it('늦은 버튼은 다음 질문을 승인하지 않고 삭제의 두 질문이 서로 다른 번호를 쓴다', async () => {
    const sent: Record<string, any>[] = [];
    const t = new ServerTransport(m => sent.push(m));
    const result: string[] = [];
    const done = t.run('first', async () => {
      result.push(await t.ask('삭제할까요?', '', 3000, { destructive: true }));
      result.push(await t.ask('정말로 삭제할까요?', '', 3000, { destructive: true }));
    });
    await tick();
    const one = sent.at(-1)!.prompt;
    t.answer('a1', '예', one.id);
    await tick();
    const two = sent.at(-1)!.prompt;
    expect(two.id).not.toBe(one.id);
    expect(two.destructive).toBe(true);
    t.answer('late', '예', one.id);
    await tick();
    expect(result).toEqual(['yes']);
    t.answer('a2', '아니오', two.id);
    await done;
    expect(result).toEqual(['yes','no']);
  });
  it('AI 결과 도착 전에 잠금/취소되면 승인하지 않는다', async () => {
    const t = new ServerTransport(() => {}, undefined, async (_q, _a, signal) => {
      await new Promise(resolve => signal!.addEventListener('abort', resolve, { once: true }));
      return 'yes';
    });
    let result: string | undefined;
    const done = t.run('one', async () => { result = await t.ask('복사할까요?', '', 1000); });
    await tick(); t.answer('two', '진행해'); await tick(); t.cancelWaiting();
    await done; expect(result).toBe('timeout');
  });
  it('후보 선택은 버튼 정보와 기존 번호 답변을 함께 제공한다', async () => {
    const sent: Record<string, any>[] = [];
    const t = new ServerTransport(m => sent.push(m));
    let result: number | null = null;
    const done = t.run('one', async () => { result = await t.choose('어느 파일?', ['test/a','test/sub/a'], 3000); });
    await tick();
    expect(sent[0].prompt.options).toEqual(['test/a','test/sub/a']);
    t.answer('two', '2', sent[0].prompt.id); await done;
    expect(result).toBe(1);
  });
});
