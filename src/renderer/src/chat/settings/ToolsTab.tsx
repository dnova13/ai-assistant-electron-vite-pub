// 설정 > 파일 제어: 관리 / 허용 경로 / 이름 찾기. 변경은 전체 저장을 눌러 반영한다.
import { useEffect, useState } from 'react';
import type { RootEntry, RootError, Settings } from '@shared/types';
import { DAYS, TRASH_DIR, normalizeDays } from '@shared/local-files';

interface Props {
  roots: RootEntry[];
  errors: RootError[];
  setRoots: (roots: RootEntry[], errors?: RootError[]) => void;
  onError: (msg: string) => void;
  settings: Settings;
  update: (fn: (s: Settings) => Settings) => void;
}

type FileSub = 'manage' | 'roots' | 'names';
const FILE_SUBS: [FileSub, string][] = [['manage', '관리'], ['roots', '허용 경로'], ['names', '이름 찾기']];
let lastSub: FileSub = 'manage';

export function ToolsTab({ roots, errors, setRoots, onError, settings, update }: Props) {
  const [sub, setSub] = useState<FileSub>(lastSub);
  const files = settings.files;
  const setFiles = (patch: Partial<Settings['files']>) => update((s) => ({ ...s, files: { ...s.files, ...patch } }));
  const [recv, setRecv] = useState<{ path: string; isDefault: boolean; defaultPath: string } | null>(null);
  const [daysText, setDaysText] = useState(String(files.trashDays));

  // 받은 파일 폴더 (편집 중인 값 기준. 비었으면 기본 경로)
  useEffect(() => {
    let alive = true;
    window.app.files
      .receivedDir(files.receivedDir)
      .then((r) => alive && setRecv(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [files.receivedDir]);

  const add = async () => {
    const r = await window.app.tools.pickFolder();
    if (!r) return;
    if (r.error) return setRoots(roots, [{ path: r.path, label: r.label, reason: r.error }]);
    setRoots([...roots, { id: `r${Date.now()}`, label: r.label, path: r.path }]);
  };

  const pickReceived = async () => {
    try {
      const p = await window.app.files.pickReceivedDir();
      if (p) setFiles({ receivedDir: p });
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div id="tab-tools" className="tabPane">
      <nav className="subtabs" role="tablist" aria-label="파일 제어">
        {FILE_SUBS.map(([id, label]) => (
          <button key={id} id={`file-tab-${id}`} type="button" role="tab" aria-selected={sub === id} aria-controls={`file-panel-${id}`} className={sub === id ? 'subtab active' : 'subtab'} onClick={() => { lastSub = id; setSub(id); }}>
            {label}
          </button>
        ))}
      </nav>
      {sub === 'roots' && <section className="tabPane" id="file-panel-roots" role="tabpanel" aria-labelledby="file-tab-roots">
      <p className="hint">파일 명령은 아래 허용 폴더 안에서만 됩니다 (앱에서 하든 메신저에서 하든 같음). 홈 폴더 전체, 디스크 전체, 시스템 폴더는 추가할 수 없습니다.</p>
      <b>허용 경로</b>
      <div id="rootList">
        {roots.map((r, i) => (
          <div className="rootItem" key={r.id + r.path}>
            <div className="rootRow">
              <input
                type="text"
                value={r.label}
                title="부르는 이름 (예: 문서) — 명령에서 이 이름으로 폴더를 가리킵니다"
                onChange={(e) => setRoots(roots.map((x, j) => (j === i ? { ...x, label: e.target.value.trim() } : x)), errors)}
              />
              <label className="check" title="체크하면 디스코드 원격 지시가 이 폴더를 다룰 수 있습니다">
                <input type="checkbox" checked={!!r.remote} onChange={(e) => setRoots(roots.map((x, j) => (j === i ? { ...x, remote: e.target.checked } : x)), errors)} /> 원격 허용
              </label>
              <button type="button" title="Finder나 탐색기에서 이 폴더를 엽니다" onClick={() => window.app.tools.openRoot(r.path).catch((e) => onError((e as Error).message))}>
                폴더 열기
              </button>
              <button title="허용 목록에서만 뺍니다 (폴더는 그대로)" onClick={() => setRoots(roots.filter((_, j) => j !== i))}>
                빼기
              </button>
            </div>
            <input className="rootPath mono" type="text" readOnly value={r.path} title={r.path} aria-label={`${r.label} 경로`} />
          </div>
        ))}
        {!roots.length && <p className="warn">허용 폴더가 없으면 파일 명령을 쓸 수 없습니다 (받은 파일 폴더는 따로 허용됨).</p>}
      </div>
      <div className="row">
        <button id="btnAddRoot" type="button" onClick={() => void add()}>
          폴더 추가
        </button>
        <button id="btnResetRoots" type="button" onClick={async () => setRoots(await window.app.tools.defaultRoots())}>
          기본값으로
        </button>
      </div>
      <p className="hint" id="rootErrors" style={{ whiteSpace: 'pre-line' }}>
        {errors.map((e) => `${e.label || e.path}: ${e.reason}`).join('\n')}
      </p>

      </section>}

      {sub === 'manage' && <section className="tabPane" id="file-panel-manage" role="tabpanel" aria-labelledby="file-tab-manage">

      <div className="sttBox" id="receivedBox">
        <b>받은 파일 폴더</b>
        <p className="hint">메신저로 받은 파일은 대화창의 "다운로드"를 누르면 여기에 저장됩니다. 이 폴더는 자동으로 허용 폴더에 들어갑니다.</p>
        <div className="mono" id="receivedPath">
          {recv ? recv.path : '…'}
          {recv && recv.isDefault ? ' (기본 경로)' : ''}
        </div>
        <div className="row wrap">
          <button id="btnOpenReceived" type="button" onClick={() => window.app.files.openReceivedDir(files.receivedDir).catch((e) => onError((e as Error).message))}>
            폴더 열기
          </button>
          <button id="btnPickReceived" type="button" onClick={() => void pickReceived()}>
            폴더 지정
          </button>
          <button id="btnDefaultReceived" type="button" disabled={!files.receivedDir} onClick={() => setFiles({ receivedDir: '' })}>
            기본 경로로
          </button>
        </div>
      </div>

      <div className="sttBox" id="trashBox">
        <b>삭제한 파일 ({TRASH_DIR})</b>
        <p className="hint">
          삭제하면 진짜로 지우지 않고 허용 폴더 안의 {TRASH_DIR}/날짜 폴더로 옮깁니다. 되돌리려면 그 폴더에서 꺼내면 됩니다.
        </p>
        <label className="check">
          <input id="trashManual" type="radio" name="trashMode" checked={files.trashMode === 'manual'} onChange={() => setFiles({ trashMode: 'manual' })} /> 직접 관리 (앱은 비우지 않음)
        </label>
        <label className="check">
          <input id="trashAuto" type="radio" name="trashMode" checked={files.trashMode === 'auto'} onChange={() => setFiles({ trashMode: 'auto' })} /> 자동 비우기
        </label>
        {files.trashMode === 'auto' && (
          <label>
            며칠이 지나면 비울까요? ({DAYS.min}~{DAYS.max}일)
            <input
              id="trashDays"
              type="number"
              min={DAYS.min}
              max={DAYS.max}
              required
              value={daysText}
              onChange={(e) => setDaysText(e.target.value)}
              onBlur={() => {
                const n = normalizeDays(daysText === '' ? DAYS.def : daysText);
                setDaysText(String(n));
                setFiles({ trashDays: n });
              }}
            />
          </label>
        )}
        {files.trashMode === 'auto' && <p className="hint">앱을 켤 때와 6시간마다, 이 기간이 지난 날짜 폴더를 진짜로 지웁니다.</p>}
      </div>

      <div className="row">
        <button id="btnOpenLog" type="button" onClick={() => window.app.tools.openLog().catch((e) => onError((e as Error).message))}>
          실행 기록 보기
        </button>
      </div>
      </section>}

      {sub === 'names' && <section className="tabPane" id="file-panel-names" role="tabpanel" aria-labelledby="file-tab-names">
        <p className="hint">입력한 이름과 한글·영문 발음이 비슷한 파일·폴더를 함께 찾습니다. 음성과 텍스트, 앱과 메신저에 같은 설정을 적용합니다.</p>
        <div className="sttBox">
          <b>이름을 찾는 방법</b>
          <label className="check">
            <input type="radio" name="fileNameMethod" value="local" checked={settings.tools.nameMethod === 'local'} onChange={() => update((s) => ({ ...s, tools: { ...s.tools, nameMethod: 'local' } }))} /> 이 컴퓨터에서 찾기
          </label>
          <p className="hint">앱에 포함된 발음 사전과 비교 규칙으로 찾습니다. AI 서버 연결 없이 사용할 수 있습니다. 사전에 없는 이름은 발음으로 찾지 못할 수 있습니다.</p>
          <label className="check">
            <input type="radio" name="fileNameMethod" value="assistant" checked={settings.tools.nameMethod === 'assistant'} onChange={() => update((s) => ({ ...s, tools: { ...s.tools, nameMethod: 'assistant' } }))} /> AI 비서로 찾기
          </label>
          <p className="hint">실제 이름 후보를 내 서버의 AI 비서에 보내 비교합니다. 앱은 현재 캐릭터의 내 서버 프로필을, 비서 봇은 등록된 서버 프로필을 사용합니다. 연결과 처리 시간이 필요합니다.</p>
        </div>
        <p className="hint">예: “마이 뮤직”으로 “마이 뮤직”과 “My Music”을 함께 찾습니다. 여러 후보가 있으면 선택받고, 새로 만들 파일·폴더 이름은 입력한 그대로 씁니다.</p>
        <p className="hint">이 설정은 이름 찾기에만 적용됩니다. 자유로운 문장을 명령으로 해석하는 기능은 AI 비서가 필요합니다. 바꾼 뒤 아래 저장을 눌러 주세요.</p>
      </section>}
    </div>
  );
}
