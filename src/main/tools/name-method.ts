import type { FileNameMatcher, FileNameMethod } from '@shared/file-names';
import { matchLocalFileNames } from './local-name-matcher';

/** 선택한 방식만 사용한다. AI 연결 실패를 로컬 결과로 숨기지 않는다. */
export function selectNameMatcher(method: FileNameMethod, assistant: FileNameMatcher | null): FileNameMatcher {
  if (method === 'local') return matchLocalFileNames;
  return assistant ?? (async () => { throw new Error('AI 비서로 이름을 찾으려면 사용할 내 서버 프로필을 연결해 주세요. 설정 > 파일 제어 > 이름 찾기에서 이 컴퓨터로 바꿀 수도 있습니다.'); });
}
