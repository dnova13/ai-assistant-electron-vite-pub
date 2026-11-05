import { useSyncExternalStore } from 'react';
import type { ChatController, ChatState } from './controller';

/** 컨트롤러 상태를 React에서 읽는다. 상태가 바뀌면 다시 그린다. */
export function useChat(controller: ChatController): ChatState {
  return useSyncExternalStore(controller.subscribe, controller.getState);
}
