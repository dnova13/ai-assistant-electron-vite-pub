// "파일 <동작> ..." 명령 해석은 메신저와 같이 쓰려고 shared/commands.ts로 옮겼다. 화면 코드는 여기서 그대로 가져다 쓴다.
export { ACTION_NAMES, LOCAL_HELP, REMOTE_HELP, SUPPORTED_ACTIONS, isSupportedAction, normalizeFileText, parseLocalCommand, tokenize } from '@shared/commands';
export type { LocalCommand } from '@shared/commands';
