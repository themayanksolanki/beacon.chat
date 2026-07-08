import { createNavigationContainerRef } from "@react-navigation/native";

import type { MainStackParamList } from "../../App";

export const navigationRef = createNavigationContainerRef<MainStackParamList>();

// Both call screens can be pushed from outside any screen's own navigation
// prop (an incoming call can arrive while the user is anywhere in the app),
// so dismissal has to go through this ref too, and only pops if one of them
// is actually the screen currently on top.
export function dismissCallScreen(): void {
  if (!navigationRef.isReady()) return;
  const routeName = navigationRef.getCurrentRoute()?.name;
  if (routeName === "ActiveCall" || routeName === "IncomingCall") {
    navigationRef.goBack();
  }
}

// A notification tap can arrive before the navigator has mounted (a cold
// start launched by tapping it) — in that case the target is stashed here
// and flushed once NavigationContainer's onReady fires.
let pendingConversationId: string | null = null;

export function navigateToConversation(conversationId: string): void {
  if (navigationRef.isReady()) {
    navigationRef.navigate("Chat", { conversationId });
  } else {
    pendingConversationId = conversationId;
  }
}

export function flushPendingNavigation(): void {
  if (pendingConversationId && navigationRef.isReady()) {
    const conversationId = pendingConversationId;
    pendingConversationId = null;
    navigationRef.navigate("Chat", { conversationId });
  }
}
