/** 연결만으로 인증되지 않는다. 실제 잠금 해제는 DM의 코드로 한다. */
export const AUTH_HELP = `인증 방법
1. 앱 설정 > 원격 > 인증·잠금에서 인증 키를 만들고 QR을 Microsoft Authenticator 또는 Google Authenticator에 등록하세요.
2. 인증 앱에 표시된 현재 6자리 코드를 이 봇의 DM에 보내세요: 인증 <6자리 코드>
  인증 / 인증 도움말: 이 안내
  인증 폐기 / 잠금: 현재 인증을 종료하고 잠금 (인증 키·복구 코드는 유지)
  복구 <복구 코드>: 인증 앱을 못 쓸 때 한 번만 사용
설정창의 '코드 확인'은 등록 시험용이며 잠금을 풀지 않습니다.`;

export const AUTH_REQUIRED = `먼저 인증해 주세요. 인증 전에는 대화·찾기·목록·파일 보내기/받기 등 일반 기능을 사용할 수 없습니다.\n${AUTH_HELP}`;
export const CHANNEL_AUTH_REQUIRED = `먼저 인증해 주세요. 인증 코드는 이 채널이 아닌 봇 DM에서만 보내세요.\n${AUTH_HELP}\nDM에서 인증한 뒤 이 채널에서 다시 요청하세요.`;

/** 앱·비서 봇이 전달하는 파일 접두어도 같은 제어 명령으로 읽는다. */
export function remoteControlText(text: string): string {
  return text.trim().replace(/^!?파일\s+(?=(?:인증|복구|잠금|상태|원격 중지)(?:\s|$))/, '').replace(/^!(?=인증(?:\s|$))/, '');
}
