// 마이크 아이콘 (선 모양). 글자색(currentColor)을 따라가서 녹음 중 색 바꾸기도 CSS로 한다.
export function MicIcon({ size = 18 }: { size?: number }) {
  return (
    <svg className="micIcon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21" />
    </svg>
  );
}
