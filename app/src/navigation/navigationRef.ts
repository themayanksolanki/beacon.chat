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
