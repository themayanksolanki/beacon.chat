import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import type { EventSubscription } from "expo-modules-core";

import { getActiveConversationId } from "./activeChatTracker";

// Android 8+ requires a channel for a notification to show as a heads-up
// banner; without one, expo-notifications falls back to a default-importance
// channel that stays silent in the notification shade.
const MESSAGES_CHANNEL_ID = "messages";

// Everything in this file is the seam a future push-notification (FCM/APNs)
// integration plugs into:
//  - the presentation rule in configureNotificationHandler() applies to any
//    notification shown while foregrounded, local or remote, so "don't
//    interrupt the chat you're already looking at" keeps working unchanged;
//  - notifyNewMessage() is the one place that decides "should this incoming
//    message produce a notification" — a server-driven push would replace
//    the scheduleNotificationAsync call inside it, not the call sites;
//  - the tap-handling helpers below read the same NewMessageNotificationPayload
//    shape a remote push's data payload would carry.
export interface NewMessageNotificationPayload {
  conversationId: string;
  senderId: string;
  senderName: string;
  messageId: string;
  messagePreview: string;
  timestamp: number;
}

let configured = false;

/** Idempotent — safe to call from more than one mount. */
export function configureNotificationHandler(): void {
  if (configured) return;
  configured = true;

  if (Platform.OS === "android") {
    void Notifications.setNotificationChannelAsync(MESSAGES_CHANNEL_ID, {
      name: "Messages",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const conversationId = notification.request.content.data?.conversationId;
      const isViewingThisChat =
        AppState.currentState === "active" &&
        typeof conversationId === "string" &&
        conversationId === getActiveConversationId();

      return {
        shouldShowBanner: !isViewingThisChat,
        shouldShowList: !isViewingThisChat,
        shouldPlaySound: !isViewingThisChat,
        shouldSetBadge: false,
      };
    },
  });
}

export async function requestNotificationPermissionsAsync(): Promise<void> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return;
  await Notifications.requestPermissionsAsync();
}

/**
 * The one place that decides whether an incoming message should produce a
 * notification. Scheduling with `identifier: conversationId` means a second
 * message from the same still-unread conversation replaces the tray entry
 * instead of stacking a duplicate banner.
 */
export async function notifyNewMessage(payload: NewMessageNotificationPayload): Promise<void> {
  const isViewingThisChat =
    AppState.currentState === "active" && getActiveConversationId() === payload.conversationId;
  if (isViewingThisChat) return;

  await Notifications.scheduleNotificationAsync({
    identifier: payload.conversationId,
    content: {
      title: payload.senderName,
      body: payload.messagePreview,
      data: { ...payload },
      ...(Platform.OS === "android" ? { channelId: MESSAGES_CHANNEL_ID } : null),
    },
    trigger: null,
  });
}

export async function clearNotificationsForConversation(conversationId: string): Promise<void> {
  await Notifications.dismissNotificationAsync(conversationId).catch(() => {});
}

function payloadFromResponse(response: Notifications.NotificationResponse): NewMessageNotificationPayload | null {
  const data = response.notification.request.content.data;
  if (!data || typeof data.conversationId !== "string") return null;
  return data as unknown as NewMessageNotificationPayload;
}

/** Warm/background taps — fires while the JS environment is already running. */
export function addNotificationTapListener(
  onTap: (payload: NewMessageNotificationPayload) => void
): EventSubscription {
  return Notifications.addNotificationResponseReceivedListener((response) => {
    const payload = payloadFromResponse(response);
    if (payload) onTap(payload);
  });
}

/** Cold-start taps — call once at startup to catch the notification that launched the app. */
export function consumeLastNotificationResponse(): NewMessageNotificationPayload | null {
  const response = Notifications.getLastNotificationResponse();
  if (!response) return null;
  Notifications.clearLastNotificationResponse();
  return payloadFromResponse(response);
}
