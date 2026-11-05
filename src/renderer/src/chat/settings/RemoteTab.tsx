// 설정 > 원격: 비서 서버 연결 / 앱 직접 연결 / 인증·잠금 / 보낸 파일.
// 연결 정보와 기간은 맨 아래 "저장"으로 저장하면 다시 연결한다. 키·잠금·원격 중지는 누르면 바로 적용된다.
import { useEffect, useRef, useState } from 'react';
import type { Character, RemoteStatus, Settings } from '@shared/types';
import { remoteCharacter, NO_REMOTE_CHARACTER } from '@shared/remote-character';
import type { ItemApi } from './itemSave';
import { DAYS, UNLOCK_MIN, formatMinutes, normalizeDays, normalizeUnlockMinutes } from '@shared/local-files';

interface Props {
  settings: Settings;
  savedSettings: Settings;
  characters: Character[];
  update: (fn: (s: Settings) => Settings) => void;
  item: ItemApi | null;
  onError: (msg: string) => void;
}

type RemoteSub = 'direct' | 'server' | 'auth' | 'sent';
const REMOTE_SUBS: [RemoteSub, string][] = [['server', '비서 서버 연결'], ['direct', '앱 직접 연결'], ['auth', '인증·잠금'], ['sent', '보낸 파일']];
let lastSub: RemoteSub = 'server';

type Unit = 'min' | 'hour' | 'day';
const UNIT_MIN: Record<Unit, number> = { min: 1, hour: 60, day: 1440 };
const errText = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** 분 → 보기 좋은 단위 */
function splitMinutes(min: number): { value: number; unit: Unit } {
  if (min % 1440 === 0) return { value: min / 1440, unit: 'day' };
  if (min % 60 === 0) return { value: min / 60, unit: 'hour' };
  return { value: min, unit: 'min' };
}

function leftText(until: number): string {
  const min = Math.max(0, Math.round((until - Date.now()) / 60000));
  return `${formatMinutes(min)} 남음 (${new Date(until).toLocaleString('ko-KR')}까지)`;
}

export function RemoteTab({ settings, savedSettings, characters, update, item, onError }: Props) {
  const [sub, setSub] = useState<RemoteSub>(lastSub);
  const r = settings.remote;
  const setRemote = (patch: Partial<Settings['remote']>) => update((s) => ({ ...s, remote: { ...s.remote, ...patch } }));
  const setDiscord = (patch: Partial<Settings['remote']['discord']>) => update((s) => ({ ...s, remote: { ...s.remote, discord: { ...s.remote.discord, ...patch } } }));
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [key, setKey] = useState<{ qr: string; secret: string; recovery: string[] } | null>(null);
  const [askNewKey, setAskNewKey] = useState(false);
  const [code, setCode] = useState('');
  const [codeRes, setCodeRes] = useState<{ cls: '' | 'ok' | 'fail'; text: string }>({ cls: '', text: '' });
  const init = splitMinutes(r.unlockMinutes);
  const [unlockVal, setUnlockVal] = useState(String(init.value));
  const [unlockUnit, setUnlockUnit] = useState<Unit>(init.unit);
  const [unlockNote, setUnlockNote] = useState('');
  const [daysText, setDaysText] = useState(String(r.sentDeleteDays));
  const [askDelAll, setAskDelAll] = useState(false);
  const [delRes, setDelRes] = useState('');
  const [, tick] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [connError, setConnError] = useState('');
  const serverProfiles = Object.entries(settings.profiles).filter(([, p]) => p.type === 'assistant');
  const [serverProfile, setServerProfile] = useState(settings.profiles[settings.activeProfile]?.type === 'assistant' ? settings.activeProfile : serverProfiles[0]?.[0] || '');
  useEffect(() => {
    const profile = st?.server.profile;
    if (profile && settings.profiles[profile]?.type === 'assistant') setServerProfile(profile);
  }, [st?.server.profile]);
  const [computerName, setComputerName] = useState('');
  const [askUnregister, setAskUnregister] = useState(false);
  const [serverBusy, setServerBusy] = useState(false);
  const serverPending = useRef(false);
  const wasRegistered = useRef(false);
  useEffect(() => {
    if (wasRegistered.current && st && !st.server.registered) { setComputerName(''); setAskUnregister(false); }
    if (st) wasRegistered.current = st.server.registered;
  }, [st]);
  const runServer = async (fn: () => Promise<RemoteStatus>) => {
    if (serverPending.current) return;
    serverPending.current = true; setServerBusy(true);
    try {
      const status = await fn(); setSt(status); setComputerName('');
    } catch (e) { onError(errText(e)); }
    finally { serverPending.current = false; setServerBusy(false); }
  };

  useEffect(() => {
    let alive = true;
    window.app.remote
      .status()
      .then((s) => alive && setSt(s))
      .catch(() => {});
    const off = window.app.remote.onEvent((ev) => {
      if (ev.type === 'status') setSt(ev.status);
    });
    const t = setInterval(() => tick((n) => n + 1), 30_000); // 남은 시간 표시
    return () => {
      alive = false;
      off();
      clearInterval(t);
    };
  }, []);

  const run = async (fn: () => Promise<RemoteStatus | void>) => {
    try {
      const s = await fn();
      if (s) setSt(s);
    } catch (e) {
      onError(errText(e));
    }
  };

  const applyUnlock = (val: string, unit: Unit) => {
    const raw = Number(val) * UNIT_MIN[unit];
    const n = normalizeUnlockMinutes(val === '' || !Number.isFinite(raw) ? UNLOCK_MIN.def : raw);
    setUnlockNote(n !== raw ? `${formatMinutes(UNLOCK_MIN.min)}~${formatMinutes(UNLOCK_MIN.max)} 사이로 맞췄습니다: ${formatMinutes(n)}` : '');
    const sp = splitMinutes(n);
    setUnlockVal(String(sp.value));
    setUnlockUnit(sp.unit);
    setRemote({ unlockMinutes: n });
  };

  const newKey = async () => {
    setAskNewKey(false);
    setCodeRes({ cls: '', text: '' });
    try {
      setKey(await window.app.remote.newKey());
      setSt(await window.app.remote.status());
    } catch (e) {
      onError(errText(e));
    }
  };

  const checkCode = async () => {
    const ok = await window.app.remote.checkCode(code).catch(() => false);
    setCodeRes(ok ? { cls: 'ok', text: '맞습니다. 인증 앱에 잘 등록되었습니다.' } : { cls: 'fail', text: '코드가 맞지 않습니다. 폰 시계가 맞는지, 새 코드인지 확인하세요.' });
  };

  // 입력한 값으로 먼저 연결해 보고, 되면 메인이 저장한다. 화면의 저장된 값도 맞춘다 (같은 값이라 다시 연결하지 않는다)
  const connectDiscord = async () => {
    setReconnecting(true);
    setConnError('');
    try {
      const res = await window.app.remote.connectDiscord({ enabled: r.enabled, apiKey: r.discord.apiKey, userId: r.discord.userId });
      setSt(res.status);
      if (!res.ok) setConnError(res.error);
      else if (item) await item.save({ kind: 'discord' });
    } catch (e) {
      onError(errText(e));
    } finally {
      setReconnecting(false);
    }
  };

  const connBusy = r.enabled && (reconnecting || !!st?.connecting);
  const connText = !st
    ? '…'
    : !r.enabled
      ? '꺼짐'
      : connBusy
        ? '연결 중...'
        : connError
          ? `연결 안 됨: ${connError}${st.connected ? ' (저장된 값으로 다시 연결함)' : ''}`
          : st.connected
        ? `연결됨 (${st.botName})`
        : st.error
          ? `연결 안 됨: ${st.error}`
          : '연결 안 됨';

  const link = st ? st.server : null;
  const linkText = !link
    ? '…'
    : link.state === 'connected'
      ? '연결됨'
      : link.state === 'connecting'
        ? '연결하는 중'
        : link.state === 'waiting'
          ? `다시 연결 대기: ${link.error}`
          : link.error || (link.on ? '연결 안 됨' : '꺼짐');

  const targetCharacter = remoteCharacter(savedSettings, characters, link?.registered ? link.profile : serverProfile);

  const authText = !st ? '인증 상태 확인 중' : st.stopped ? '원격 중지됨' : st.unlockedUntil > Date.now() ? `인증됨 · ${leftText(st.unlockedUntil)}` : '인증 필요';

  return (
    <div id="tab-remote" className="tabPane">
      <nav className="subtabs remoteTabs" role="tablist" aria-label="원격 설정">
        {REMOTE_SUBS.map(([id, label]) => (
          <button key={id} id={`remote-tab-${id}`} type="button" role="tab" aria-selected={sub === id} aria-controls={`remote-panel-${id}`} className={sub === id ? 'subtab active' : 'subtab'} onClick={() => { lastSub = id; setSub(id); }}>
            {label}
          </button>
        ))}
      </nav>
      <section className="remotePanel" id="remote-panel-direct" role="tabpanel" aria-labelledby="remote-tab-direct" hidden={sub !== 'direct'}>
      <p className="hint">이 앱이 디스코드 봇에 직접 연결합니다. 비서 서버 연결과 동시에 쓰려면 서로 다른 봇 토큰을 사용하세요. 봇 만드는 법은 프로젝트 README를 보세요.</p>

      <div className="sttBox" id="discordBox">
        <b>앱 직접 연결</b>
        <label className="check">
          <input id="remoteEnabled" type="checkbox" checked={r.enabled} onChange={(e) => setRemote({ enabled: e.target.checked })} /> 디스코드 연결 켜기
        </label>
        <label>
          봇 토큰
          <div className="row">
            <input id="discordToken" type={showToken ? 'text' : 'password'} autoComplete="off" value={r.discord.apiKey} onChange={(e) => setDiscord({ apiKey: e.target.value.trim() })} />
            <button type="button" onClick={() => setShowToken((v) => !v)}>
              {showToken ? '숨김' : '보기'}
            </button>
          </div>
        </label>
        <label>
          내 디스코드 사용자 ID (이 사람의 DM만 받음)
          <input id="discordUserId" type="text" inputMode="numeric" placeholder="예: 123456789012345678" value={r.discord.userId} onChange={(e) => setDiscord({ userId: e.target.value.replace(/\D/g, '') })} />
        </label>
        <div className="row wrap">
          <span id="remoteConn" className={connBusy ? 'busy' : connError ? 'fail' : st?.connected && st.unlockedUntil > Date.now() && !st.stopped ? 'ok' : st?.error ? 'fail' : ''}>
            {connBusy && <span className="spin" aria-hidden="true" />}
            <span id="directAuthState">{connText}{st?.connected ? ` · ${authText}` : ''}</span>
          </span>
          <button
            id="btnRemoteReconnect"
            type="button"
            disabled={connBusy}
            onClick={() => void connectDiscord()}
          >
            연결
          </button>
        </div>
        <p className="hint">인증 전에는 일반 대화와 모든 파일 기능을 사용할 수 없습니다. 연결 켜기를 해제하고 저장하면 인증도 종료됩니다. 다시 연결하거나 앱 직접 연결 상태로 앱을 다시 켜면 재인증해야 합니다.</p>
        <p className="hint">연결을 누르면 먼저 연결해 보고, 연결되면 이 칸의 값을 저장합니다. 안 되면 저장하지 않습니다. 토큰은 키체인/DPAPI로 암호화해 저장합니다.</p>
      </div>

      </section>
      <section className="remotePanel" id="remote-panel-server" role="tabpanel" aria-labelledby="remote-tab-server" hidden={sub !== 'server'}>
      <div className="sttBox" id="serverLinkBox">
        <b>비서 서버 연결</b>
        {targetCharacter ? <p id="serverCharacterHint" className="hint">디스코드 요청 캐릭터: {targetCharacter.config.name} · 현재 캐릭터가 같은 AI를 사용하면 그대로 처리하고, 다른 AI이면 연결된 표시 캐릭터 중 첫 번째를 사용합니다.</p> : <div id="serverCharacterWarning" role="alert">
          <p className="warn">{NO_REMOTE_CHARACTER}</p>
          <button type="button" onClick={() => void window.app.settingsWindow.open('character')}>캐릭터 설정 열기</button>
        </div>}
        <p className="hint">이 컴퓨터를 내 서버에 등록하고 연결을 열어 둡니다. 스위치를 끄면 연결하지 않습니다. 앱 대화창의 파일 명령은 스위치와 상관없이 됩니다. 비서 봇의 `!파일`은 설정 &gt; 파일 제어 &gt; 허용 경로에서 원격 허용을 체크한 폴더만 다룹니다.</p>
        <p className="hint">연결을 해제해도 서버 등록은 남아 같은 컴퓨터로 다시 연결할 수 있습니다. 이름을 바꿔 등록하면 기존 컴퓨터 이름을 변경합니다. 서버 등록 삭제는 디스코드의 !컴퓨터 &lt;이름&gt; 삭제에서 합니다.</p>
        {link && link.registered ? (
          <>
            <div className="kv">
              <span className="k">컴퓨터 이름</span>
              <span className="v" id="serverComputerName">
                {link.name}
              </span>
            </div>
            <label className="check">
              <input id="serverAllow" disabled={serverBusy} type="checkbox" checked={link.on} onChange={(e) => void run(() => window.app.remote.serverAllow(e.target.checked))} /> 서버 원격 허용
            </label>
            <div className="row wrap">
              {askUnregister ? (
                <span className="itemAsk">
                  <button
                    id="btnServerUnregisterYes"
                    disabled={serverBusy}
                    type="button"
                    className="danger"
                    onClick={() => {
                      setAskUnregister(false);
                      void runServer(() => window.app.remote.serverUnregister());
                    }}
                  >
                    연결 해제
                  </button>
                  <button type="button" onClick={() => setAskUnregister(false)}>
                    취소
                  </button>
                </span>
              ) : (
                <button id="btnServerUnregister" disabled={serverBusy} type="button" onClick={() => setAskUnregister(true)}>
                  연결 해제
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <label>
              내 서버 프로필
              <select id="serverProfile" value={serverProfile} onChange={(e) => setServerProfile(e.target.value)}>
                {serverProfiles.length === 0 && <option value="">설정 &gt; AI에 내 서버를 먼저 추가하세요</option>}
                {serverProfiles.map(([id, p]) => (
                  <option key={id} value={id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              컴퓨터 이름 (빈칸 없이. 예: 소니)
              <input id="serverComputerInput" type="text" maxLength={30} value={computerName} onChange={(e) => setComputerName(e.target.value)} />
            </label>
            <div className="row wrap">
              <button
                id="btnServerRegister"
                type="button"
                disabled={serverBusy || !serverProfile || !computerName.trim()}
                onClick={() => void runServer(() => window.app.remote.serverRegister(serverProfile, computerName.trim()))}
              >
                서버에 등록
              </button>
            </div>
          </>
        )}
        <span id="serverLinkState" className={link?.state === 'connected' && st && st.unlockedUntil > Date.now() && !st.stopped ? 'ok' : link?.error ? 'fail' : ''}>
          {linkText}{link?.state === 'connected' ? ` · ${authText}` : ''}
        </span>
      </div>

      </section>
      <section className="remotePanel" id="remote-panel-auth" role="tabpanel" aria-labelledby="remote-tab-auth" hidden={sub !== 'auth'}>
      <div className="sttBox" id="totpBox">
        <b>인증 앱 (Microsoft Authenticator, Google Authenticator) 등록</b>
        <p className="hint">실제 인증은 디스코드 봇 DM에 인증 &lt;6자리 코드&gt;를 보내서 합니다. 앱 직접 연결은 인증 전 모든 일반 기능을 막습니다. 같은 QR을 두 앱에 모두 등록하면 어느 앱의 코드든 됩니다. 키는 이 컴퓨터에만 있습니다.</p>
        <div className="row wrap">
          <span id="keyState">{st ? (st.keySet ? `키 있음 (복구 코드 ${st.recoveryLeft}개 남음)` : '키 없음') : '…'}</span>
          {askNewKey ? (
            <span className="itemAsk">
              <button id="btnNewKeyYes" type="button" className="danger" onClick={() => void newKey()}>
                폐기하고 새로 만들기
              </button>
              <button type="button" onClick={() => setAskNewKey(false)}>
                취소
              </button>
            </span>
          ) : (
            <button id="btnNewKey" type="button" onClick={() => (st && st.keySet ? setAskNewKey(true) : void newKey())}>
              {st && st.keySet ? '키 폐기·재발급' : '키 만들기'}
            </button>
          )}
        </div>
        {askNewKey && <p className="warn">지금 키를 폐기하면 인증 앱에 등록한 코드가 더 이상 맞지 않고, 잠금도 바로 걸립니다. 새 QR을 다시 등록해야 합니다.</p>}
        {key && (
          <div id="newKeyBox">
            <p className="warn">이 QR과 복구 코드는 지금 한 번만 보여 줍니다. 창을 닫기 전에 등록하고 복구 코드를 적어 두세요.</p>
            <img id="totpQr" src={key.qr} alt="인증 앱 등록 QR" width={220} height={220} />
            <p className="hint">
              QR을 못 찍으면 직접 입력: <span className="mono">{key.secret}</span>
            </p>
            <p className="hint">복구 코드 (폰을 잃었을 때 메신저에 "복구 코드"로 한 번씩 씀):</p>
            <div className="mono" id="recoveryCodes">
              {key.recovery.join('  ')}
            </div>
          </div>
        )}
        {st && st.keySet && <p className="hint">아래 코드 확인은 QR 등록 시험용입니다. 원격 잠금을 풀지는 않습니다.</p>}
        <p className="hint">DM에서 인증 또는 인증 도움말로 사용법을 보고, 인증 폐기 또는 잠금으로 현재 인증을 종료합니다. 인증 키와 복구 코드는 유지됩니다.</p>
        {st && st.keySet && (
          <div className="row wrap">
            <input id="totpCheck" type="text" inputMode="numeric" maxLength={6} placeholder="6자리 코드" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ width: 110 }} />
            <button id="btnTotpCheck" type="button" onClick={() => void checkCode()}>
              코드 확인
            </button>
            <span id="totpCheckResult" className={codeRes.cls}>
              {codeRes.text}
            </span>
          </div>
        )}
      </div>

      <div className="sttBox" id="unlockBox">
        <b>잠금 해제 시간</b>
        <p className="hint">
          인증하면 이 시간 동안 코드를 다시 입력하지 않고 기능을 씁니다 ({formatMinutes(UNLOCK_MIN.min)}~{formatMinutes(UNLOCK_MIN.max)}, 기본 {formatMinutes(UNLOCK_MIN.def)}). 시간이 지나면 다시 인증합니다.
        </p>
        <div className="row">
          <input id="unlockValue" type="number" min={1} value={unlockVal} onChange={(e) => setUnlockVal(e.target.value)} onBlur={() => applyUnlock(unlockVal, unlockUnit)} style={{ width: 90 }} />
          <select
            id="unlockUnit"
            value={unlockUnit}
            onChange={(e) => {
              const u = e.target.value as Unit;
              setUnlockUnit(u);
              applyUnlock(unlockVal, u);
            }}
          >
            <option value="min">분</option>
            <option value="hour">시간</option>
            <option value="day">일</option>
          </select>
          <span className="hint">= {formatMinutes(r.unlockMinutes)}</span>
        </div>
        {unlockNote && <p className="warn">{unlockNote}</p>}
      </div>

      <div className="sttBox" id="accessBox">
        <b>인증·원격 상태</b>
        <div className="kv">
          <span className="k">잠금</span>
          <span className="v" id="unlockState">
            {st ? (st.unlockedUntil ? `풀림 · ${leftText(st.unlockedUntil)}` : '잠김') : '…'}
          </span>
        </div>
        <div className="kv">
          <span className="k">원격 중지</span>
          <span className="v" id="stopState">
            {st ? (st.stopped ? '중지됨 (모든 원격 요청 거부)' : '아님') : '…'}
          </span>
        </div>
        <div className="row wrap">
          <button id="btnRemoteLock" type="button" disabled={!st || !st.unlockedUntil} onClick={() => void run(() => window.app.remote.lock())}>
            지금 잠그기
          </button>
          <button id="btnRemoteStop" type="button" className={st && st.stopped ? '' : 'danger'} onClick={() => void run(() => window.app.remote.setStopped(!(st && st.stopped)))}>
            {st && st.stopped ? '원격 다시 켜기' : '원격 중지'}
          </button>
        </div>
        <p className="hint">의심되면 원격 중지나 키 폐기·재발급을 누르세요. 남은 시간과 상관없이 바로 막힙니다.</p>
      </div>

      </section>
      <section className="remotePanel" id="remote-panel-sent" role="tabpanel" aria-labelledby="remote-tab-sent" hidden={sub !== 'sent'}>
      <div className="sttBox" id="sentBox">
        <b>보낸 파일 자동 삭제</b>
        <p className="hint">메신저에 올린 파일 메시지(사본)를 올린 날짜 기준으로 지웁니다. 컴퓨터의 원본은 그대로입니다. 보낸 파일의 이름·크기·경로는 글 기록으로 남깁니다.</p>
        <label>
          며칠이 지나면 지울까요? ({DAYS.min}~{DAYS.max}일)
          <input
            id="sentDays"
            type="number"
            min={DAYS.min}
            max={DAYS.max}
            required
            value={daysText}
            onChange={(e) => setDaysText(e.target.value)}
            onBlur={() => {
              const n = normalizeDays(daysText === '' ? DAYS.def : daysText);
              setDaysText(String(n));
              setRemote({ sentDeleteDays: n });
            }}
          />
        </label>
        <div className="row wrap">
          <span id="sentCount">{st ? `지울 목록: ${st.sentCount}개` : ''}</span>
          {askDelAll ? (
            <span className="itemAsk">
              <button
                id="btnDelAllSentYes"
                type="button"
                className="danger"
                onClick={() => {
                  setAskDelAll(false);
                  void window.app.remote
                    .deleteAllSent()
                    .then((x) => setDelRes(`지웠습니다: ${x.deleted}개${x.failed ? `, 못 지움: ${x.failed}개` : ''}`))
                    .catch((e) => setDelRes(errText(e)));
                }}
              >
                모두 지우기
              </button>
              <button type="button" onClick={() => setAskDelAll(false)}>
                취소
              </button>
            </span>
          ) : (
            <button id="btnDelAllSent" type="button" onClick={() => setAskDelAll(true)}>
              지금 모두 지우기
            </button>
          )}
          <button id="btnSentLog" type="button" onClick={() => window.app.remote.openSentLog().catch((e) => onError(errText(e)))}>
            보낸 파일 기록 보기
          </button>
        </div>
        {askDelAll && <p className="warn">날짜와 상관없이 메신저에 올린 파일 메시지를 모두 지울까요? 컴퓨터의 원본은 그대로입니다.</p>}
        {delRes && <p className="hint">{delRes}</p>}
      </div>
      </section>
    </div>
  );
}
