// 설정 > 음성: 하위 탭 3개 — 음성 대화(자동 전송·마이크 맞추기·이어서 대화) / 음성 인식(내 서버 → 클라우드 → 이 컴퓨터 순서, 대화 AI와 따로)
import { useState } from 'react';
import type { CloudSttProvider, Health, LocalSttModel, LocalSttStatus, Settings, SttSettings, SttSourceId } from '@shared/types';
import { geminiLabel } from '@shared/gemini-models';
import { LOCAL_MODELS, LOCAL_MODEL_INFO, SOURCE_LABEL, cloudKeyProfile, cloudLabel, sttReadiness } from '@shared/stt';
import { withCharacter } from '@shared/char-prefs';
import { VoiceConvSection } from './VoiceConvSection';
import { WakeSection } from './WakeSection';

interface Props {
  settings: Settings;
  update: (fn: (s: Settings) => Settings) => void;
  health: Health | null;
  localStt: LocalSttStatus | null;
  onLocalChanged: () => void;
  learnedNoise?: number | null;
  /** 지난번 호출어 대기 중 맞춰진 주변 소음 (호출어 탭용, 음성 대화와 따로) */
  learnedWakeNoise?: number | null;
  characterName?: string;
}

type Result = { cls: '' | 'ok' | 'fail'; text: string };

/** 음성 탭 안의 하위 탭 (고른 탭은 설정 창을 닫았다 열어도 기억한다) */
type VoiceSub = 'conv' | 'stt' | 'wake';
const VOICE_SUBS: [VoiceSub, string][] = [
  ['conv', '음성 대화'],
  ['stt', '음성 인식'],
  ['wake', '호출어']
];
let lastSub: VoiceSub = 'conv';
const EMPTY: Result = { cls: '', text: '' };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function VoiceTab({ settings, update, health, localStt, onLocalChanged, learnedNoise = null, learnedWakeNoise = null, characterName = '' }: Props) {
  const stt = settings.voice.stt;
  const setStt = (fn: (x: SttSettings) => SttSettings) => update((s) => ({ ...s, voice: { ...s.voice, stt: fn(s.voice.stt) } }));
  const [serverRes, setServerRes] = useState<Result>(EMPTY);
  const [serverModels, setServerModels] = useState<string[]>([]);
  const [cloudRes, setCloudRes] = useState<Result>(EMPTY);
  const [cloudModels, setCloudModels] = useState<string[]>([]);
  const [localErr, setLocalErr] = useState('');
  const [sub, setSubState] = useState<VoiceSub>(lastSub);
  const setSub = (v: VoiceSub) => {
    lastSub = v;
    setSubState(v);
  };

  // 대화 서버를 빌리는 단계는 지금 캐릭터가 고른 AI 기준
  const charView = withCharacter(settings, settings.character);
  const readiness = sttReadiness(charView, health, localStt ? localStt.downloaded : []);
  const note = (id: SttSourceId) => readiness.sources.find((x) => x.id === id);

  const move = (id: SttSourceId, dir: -1 | 1) =>
    setStt((x) => {
      const order = [...x.order];
      const i = order.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return x;
      [order[i], order[j]] = [order[j], order[i]];
      return { ...x, order };
    });

  const testServer = async () => {
    setServerRes({ cls: '', text: '확인 중…' });
    try {
      const r = await window.app.stt.testServer(stt.server);
      setServerModels(r.models);
      setServerRes({
        cls: 'ok',
        text: r.kind === 'v1' ? '연결 성공 · 규약 v1 서버 (음성 인식 지원)' : `연결 성공 · OpenAI 호환 서버 (모델 ${r.models.length}개${stt.server.model ? '' : ', 비우면 첫 모델 사용'})`
      });
    } catch (e) {
      setServerRes({ cls: 'fail', text: errText(e) });
    }
  };

  const testCloud = async () => {
    setCloudRes({ cls: '', text: '확인 중…' });
    try {
      const r = await window.app.stt.testCloud(stt.cloud);
      setCloudModels(r.models);
      setCloudRes({ cls: 'ok', text: `연결 성공 (모델 ${r.models.length}개)${stt.cloud.model ? '' : ' · 아래에서 모델을 고르세요'}` });
    } catch (e) {
      setCloudRes({ cls: 'fail', text: errText(e) });
    }
  };

  const download = async () => {
    setLocalErr('');
    try {
      await window.app.stt.localDownload(stt.local.model);
    } catch (e) {
      setLocalErr(errText(e));
    } finally {
      onLocalChanged();
    }
  };

  const keyFrom = cloudKeyProfile(charView, stt.cloud.provider);
  const dl = localStt && localStt.downloading;
  const modelList = (models: string[], cur: string) => (cur && !models.includes(cur) ? [cur, ...models] : models);

  const header = (id: SttSourceId, enabled: boolean, toggle: (v: boolean) => void, idx: number) => (
    <div className="sttHead">
      <label className="check">
        <input id={`stt-${id}-on`} type="checkbox" checked={enabled} onChange={(e) => toggle(e.target.checked)} />{' '}
        <b>
          {idx + 1}. {id === 'cloud' ? cloudLabel(stt.cloud.provider) : SOURCE_LABEL[id]}
        </b>
      </label>
      <span className={`sttNote ${note(id)?.ready ? 'ok' : ''}`}>{note(id)?.ready ? '사용 가능' : note(id)?.note}</span>
      <span className="sttMove">
        <button type="button" title="위로" data-move={`${id}-up`} disabled={idx === 0} onClick={() => move(id, -1)}>
          ↑
        </button>
        <button type="button" title="아래로" data-move={`${id}-down`} disabled={idx === stt.order.length - 1} onClick={() => move(id, 1)}>
          ↓
        </button>
      </span>
    </div>
  );

  const block = (id: SttSourceId, idx: number) => {
    if (id === 'server')
      return (
        <div className="sttBox" key={id} id="sttServer">
          {header(id, stt.server.enabled, (v) => setStt((x) => ({ ...x, server: { ...x.server, enabled: v } })), idx)}
          <label>
            주소
            <input
              id="sttServerUrl"
              type="text"
              placeholder="비우면 대화 서버 사용 (대화 AI가 클라우드가 아닐 때) · 예: http://192.168.0.10:8000"
              value={stt.server.baseUrl}
              onChange={(e) => setStt((x) => ({ ...x, server: { ...x.server, baseUrl: e.target.value.trim() } }))}
            />
          </label>
          {stt.server.baseUrl && (
            <>
              <label>
                키 (서버가 요구할 때만)
                <input id="sttServerKey" type="password" autoComplete="off" value={stt.server.apiKey} onChange={(e) => setStt((x) => ({ ...x, server: { ...x.server, apiKey: e.target.value.trim() } }))} />
              </label>
              <label>
                모델 (OpenAI 호환 서버일 때, 비우면 서버의 첫 모델)
                <input
                  id="sttServerModel"
                  type="text"
                  list="sttServerModels"
                  value={stt.server.model}
                  onChange={(e) => setStt((x) => ({ ...x, server: { ...x.server, model: e.target.value.trim() } }))}
                />
                <datalist id="sttServerModels">
                  {serverModels.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
              <div className="row">
                <button id="btnSttServerTest" type="button" onClick={() => void testServer()}>
                  연결 테스트
                </button>
                <span id="sttServerResult" className={serverRes.cls}>
                  {serverRes.text}
                </span>
              </div>
            </>
          )}
          <p className="hint">규약 v1 서버(/v1/stt)와 OpenAI 호환 음성 인식 서버(/v1/audio/transcriptions, 예: 서버에 올린 위스퍼)를 받습니다. 음성이 밖으로 나가지 않습니다.</p>
        </div>
      );
    if (id === 'cloud')
      return (
        <div className="sttBox" key={id} id="sttCloud">
          {header(id, stt.cloud.enabled, (v) => setStt((x) => ({ ...x, cloud: { ...x.cloud, enabled: v } })), idx)}
          <label>
            서비스
            <select
              id="sttCloudProvider"
              value={stt.cloud.provider}
              onChange={(e) => {
                setStt((x) => ({ ...x, cloud: { ...x.cloud, provider: e.target.value as CloudSttProvider, model: '' } }));
                setCloudModels([]);
                setCloudRes(EMPTY);
              }}
            >
              <option value="gemini">Gemini (1분에 약 $0.001 이하)</option>
              <option value="openai">ChatGPT / OpenAI (1분에 약 $0.006)</option>
            </select>
          </label>
          <label>
            API 키
            <input
              id="sttCloudKey"
              type="password"
              autoComplete="off"
              placeholder={keyFrom ? `비우면 대화 프로필 "${keyFrom.name}"의 키 사용` : '키를 넣으세요'}
              value={stt.cloud.apiKey}
              onChange={(e) => setStt((x) => ({ ...x, cloud: { ...x.cloud, apiKey: e.target.value.trim() } }))}
            />
          </label>
          <label>
            모델 {stt.cloud.provider === 'openai' ? '(비우면 whisper-1)' : keyFrom && keyFrom.model ? `(비우면 ${keyFrom.model})` : ''}
            <select id="sttCloudModel" value={stt.cloud.model} onChange={(e) => setStt((x) => ({ ...x, cloud: { ...x.cloud, model: e.target.value } }))}>
              <option value="">{cloudModels.length || stt.cloud.model ? '(기본)' : '(연결 테스트로 모델을 불러오세요)'}</option>
              {modelList(cloudModels, stt.cloud.model).map((m) => (
                <option key={m} value={m}>
                  {stt.cloud.provider === 'gemini' ? geminiLabel(m) : m}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button id="btnSttCloudTest" type="button" onClick={() => void testCloud()}>
              연결 테스트
            </button>
            <span id="sttCloudResult" className={cloudRes.cls}>
              {cloudRes.text}
            </span>
          </div>
          <p className="hint">{stt.cloud.provider === 'gemini' ? '음성 인식에는 flash-lite 계열(예: gemini-3.5-flash-lite)이 싸고 무료 구간 한도도 넉넉한 편입니다. 무료 구간은 사용량 제한이 있고 입력이 구글 서비스 개선에 쓰일 수 있습니다. ' : ''}녹음이 이 회사로 전송되고 말한 시간만큼 요금이 듭니다. 이 단계로 인식하면 대화 창에 "클라우드 (…)에서 인식했어요"가 표시됩니다.</p>
        </div>
      );
    const downloaded = localStt ? localStt.downloaded : [];
    return (
      <div className="sttBox" key={id} id="sttLocal">
        {header(id, stt.local.enabled, (v) => setStt((x) => ({ ...x, local: { ...x.local, enabled: v } })), idx)}
        <label>
          위스퍼 모델
          <select id="sttLocalModel" value={stt.local.model} onChange={(e) => setStt((x) => ({ ...x, local: { ...x.local, model: e.target.value as LocalSttModel } }))}>
            {LOCAL_MODELS.map((m) => (
              <option key={m} value={m}>
                {LOCAL_MODEL_INFO[m].label} · {LOCAL_MODEL_INFO[m].size}
                {downloaded.includes(m) ? ' · 받음' : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          {dl ? (
            <>
              <progress id="sttLocalProgress" max={1} value={dl.progress} />
              <span className="sttPct">{Math.round(dl.progress * 100)}%</span>
              <button id="btnSttLocalCancel" type="button" onClick={() => void window.app.stt.localCancel().finally(onLocalChanged)}>
                취소
              </button>
            </>
          ) : downloaded.includes(stt.local.model) ? (
            <span id="sttLocalStatus" className="ok">
              {stt.local.model} 모델을 받아 두었습니다.
            </span>
          ) : (
            <>
              <button id="btnSttLocalDownload" type="button" onClick={() => void download()}>
                모델 받기 ({LOCAL_MODEL_INFO[stt.local.model].size})
              </button>
              <span id="sttLocalStatus">{localErr ? <span className="fail">{localErr}</span> : '처음 한 번 받으면 인터넷 없이 씁니다.'}</span>
            </>
          )}
        </div>
        <p className="hint">
          이 컴퓨터에서 직접 인식합니다 (음성이 밖으로 나가지 않음). 그래픽 카드 없이 CPU로 돌아서 큰 모델은 느릴 수 있습니다. 한국어는 small 이상을 권합니다.
          {localStt && localStt.unavailable ? ` · ${localStt.unavailable}` : ''}
        </p>
      </div>
    );
  };

  return (
    <div id="tab-voice" className="tabPane">
      <nav className="subtabs" role="tablist">
        {VOICE_SUBS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={sub === id} className={sub === id ? 'subtab active' : 'subtab'} data-sub={id} onClick={() => setSub(id)}>
            {label}
          </button>
        ))}
      </nav>

      {sub === 'conv' && <VoiceConvSection settings={settings} update={update} learnedNoise={learnedNoise} />}

      {sub === 'wake' && <WakeSection settings={settings} update={update} characterName={characterName} downloaded={localStt ? localStt.downloaded : []} learnedNoise={learnedWakeNoise} />}

      {sub === 'stt' && (
        <>
          <h3 className="sttTitle">음성 인식 (위에서부터 시도하고, 안 되면 다음으로)</h3>
          {stt.order.map((id, i) => block(id, i))}
          <label className="half">
            내 서버·클라우드 응답 기다리는 시간 (초, 넘으면 다음으로)
            <input
              id="sttTimeout"
              type="number"
              min="3"
              max="60"
              value={stt.timeoutSec}
              onChange={(e) => setStt((x) => ({ ...x, timeoutSec: parseInt(e.target.value, 10) || 8 }))}
            />
          </label>
          <p className="hint" id="voiceStatus">
            {readiness.ready
              ? `음성 인식 사용 가능: ${readiness.sources
                  .filter((x) => x.ready)
                  .map((x) => (x.id === 'cloud' ? cloudLabel(stt.cloud.provider) : SOURCE_LABEL[x.id]))
                  .join(' → ')} 순서로 시도`
              : '음성 인식 없음: 위에서 하나 이상 켜고 설정하세요.'}
          </p>
        </>
      )}
    </div>
  );
}
