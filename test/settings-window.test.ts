import { afterEach, expect, test, vi } from 'vitest';
import { SettingsBridge } from '../src/main/settings-bridge';
import { mergeSettingsDraft } from '../src/shared/settings-draft';

afterEach(() => vi.useRealTimers());
test('설정 변경과 대화창의 변경을 합치되 같은 값의 충돌은 중단한다', () => {
  const base = { character:'a', profiles:{p:{name:'원래',model:'x'}}, lowSpec:false };
  expect(mergeSettingsDraft(base,{...base,lowSpec:true},{...base,character:'b'})).toEqual({...base,character:'b',lowSpec:true});
  expect(mergeSettingsDraft(base,{...base,profiles:{}},{...base,character:'b'})).toEqual({...base,character:'b',profiles:{}});
  expect(() => mergeSettingsDraft(base,{...base,character:'c'},{...base,character:'b'})).toThrow('다른 창');
});
test('허용한 작업과 요청 ID에 해당하는 응답만 처리한다', async () => {
  const bridge=new SettingsBridge();let id='';
  const promise=bridge.call('saveSettings',[],call=>{id=call.id});
  bridge.finish('다른 요청',null,'실패');bridge.finish(id,true);expect(await promise).toBe(true);
  await expect(bridge.call('constructor',[],()=>{})).rejects.toThrow('허용되지');
  await expect(bridge.call('saveSettings',null,()=>{})).rejects.toThrow('허용되지');
});
test('닫기·기한 초과·전달 실패 시 대기 요청을 정리한다', async () => {
  vi.useFakeTimers();const bridge=new SettingsBridge();
  const first=bridge.call('reloadCharacters',[],()=>{});const check=expect(first).rejects.toThrow('닫혔습니다');bridge.cancel();await check;
  const timed=bridge.call('reloadCharacters',[],()=>{});const expired=expect(timed).rejects.toThrow('시간');vi.advanceTimersByTime(120000);await expired;
  await expect(bridge.call('reloadCharacters',[],()=>{throw Error()})).rejects.toThrow('전달');
});
