/** AI 서버와 주고받는 것은 기존 이름과 일회성 번호뿐이다. 실제 경로는 앱에 남긴다. */
export interface FileNameCandidate {
  id: string;
  name: string;
}

export type FileNameMatcher = (query: string, candidates: FileNameCandidate[]) => Promise<string[]>;

export type FileNameMethod = 'local' | 'assistant';
export const normalizeFileNameMethod = (value: unknown): FileNameMethod => value === 'assistant' ? 'assistant' : 'local';

export const FILE_NAME_LIMIT = 128;
export const FILE_NAME_CHARS = 6000;
