import { AppState, Platform } from "react-native";
import notifee, { AndroidImportance, EventType, type Notification } from "@notifee/react-native";
import { File, Paths } from "expo-file-system";

import { getActiveConversationId } from "./activeChatTracker";

// Android 8+ requires a channel for a notification to show as a heads-up
// banner; without one it stays silent in the notification shade.
const MESSAGES_CHANNEL_ID = "messages";

// The drawable name expo-notifications' config plugin generates from the
// "icon" option in app.json (see the "expo-notifications" plugin entry) —
// a white-on-transparent silhouette, required by Android for the small
// status-bar icon. Reused here since notifee's smallIcon takes the same
// kind of Android drawable resource name.
const SMALL_ICON_RESOURCE = "notification_icon";

// Everything in this file is the seam a future push-notification (FCM/APNs)
// integration plugs into:
//  - notifyNewMessage() is the one place that decides "should this incoming
//    message produce a notification" — a server-driven push would replace
//    the displayNotification call inside it, not the call sites;
//  - the tap-handling helpers below read the same NewMessageNotificationPayload
//    shape a remote push's data payload would carry.
export interface NewMessageNotificationPayload {
  conversationId: string;
  senderId: string;
  senderName: string;
  senderAvatarUrl: string | null;
  messageId: string;
  messagePreview: string;
  timestamp: number;
}

let channelReady: Promise<void> | null = null;

/** Idempotent — safe to call from more than one mount. */
export function configureNotificationHandler(): void {
  if (channelReady) return;
  channelReady =
    Platform.OS === "android"
      ? notifee
          .createChannel({ id: MESSAGES_CHANNEL_ID, name: "Messages", importance: AndroidImportance.HIGH })
          .then(() => undefined)
      : Promise.resolve();
}

export async function requestNotificationPermissionsAsync(): Promise<void> {
  await notifee.requestPermission();
}

// iOS's UNNotificationAttachment requires a local file, unlike Android's
// largeIcon (which fetches a remote url itself) — download once per
// notification into the cache so the avatar can be attached there too.
async function localAvatarUriForIos(url: string): Promise<string | null> {
  try {
    const file = await File.downloadFileAsync(url, Paths.cache);
    return file.uri;
  } catch (err) {
    console.warn("[notifications] failed to fetch avatar for notification attachment", err);
    return null;
  }
}

/**
 * The one place that decides whether an incoming message should produce a
 * notification. Displaying with `id: conversationId` means a second message
 * from the same still-unread conversation replaces the tray entry instead
 * of stacking a duplicate banner.
 */
export async function notifyNewMessage(payload: NewMessageNotificationPayload): Promise<void> {
  const isViewingThisChat =
    AppState.currentState === "active" && getActiveConversationId() === payload.conversationId;
  if (isViewingThisChat) return;

  configureNotificationHandler();
  await channelReady;

  const iosAvatarUri =
    Platform.OS === "ios" && payload.senderAvatarUrl ? await localAvatarUriForIos(payload.senderAvatarUrl) : null;

  await notifee.displayNotification({
    id: payload.conversationId,
    title: payload.senderName,
    body: payload.messagePreview,
    data: { ...payload, senderAvatarUrl: payload.senderAvatarUrl ?? "" },
    android: {
      channelId: MESSAGES_CHANNEL_ID,
      smallIcon: SMALL_ICON_RESOURCE,
      // The contact's avatar as the big tile — the small icon above is what
      // shows as the badge in its bottom-right corner, standard Android
      // large-icon-notification compositing (WhatsApp/Messages-style).
      largeIcon: payload.senderAvatarUrl ?? undefined,
      circularLargeIcon: true,
      pressAction: { id: "default" },
    },
    ios: {
      attachments: iosAvatarUri ? [{ url: iosAvatarUri }] : undefined,
    },
  });
}

export async function clearNotificationsForConversation(conversationId: string): Promise<void> {
  await notifee.cancelNotification(conversationId).catch(() => {});
}

function payloadFromNotification(notification: Notification | undefined): NewMessageNotificationPayload | null {
  const data = notification?.data;
  if (!data || typeof data.conversationId !== "string") return null;
  return {
    conversationId: data.conversationId,
    senderId: String(data.senderId ?? ""),
    senderName: String(data.senderName ?? ""),
    senderAvatarUrl: data.senderAvatarUrl ? String(data.senderAvatarUrl) : null,
    messageId: String(data.messageId ?? ""),
    messagePreview: String(data.messagePreview ?? ""),
    timestamp: Number(data.timestamp ?? 0),
  };
}

/** Warm/background taps — fires while the JS environment is already running. */
export function addNotificationTapListener(onTap: (payload: NewMessageNotificationPayload) => void): {
  remove: () => void;
} {
  const unsubscribe = notifee.onForegroundEvent(({ type, detail }) => {
    if (type !== EventType.PRESS) return;
    const payload = payloadFromNotification(detail.notification);
    if (payload) onTap(payload);
  });
  return { remove: unsubscribe };
}

/** Cold-start taps — call once at startup to catch the notification that launched the app. */
export async function consumeLastNotificationResponse(): Promise<NewMessageNotificationPayload | null> {
  const initial = await notifee.getInitialNotification();
  if (!initial) return null;
  return payloadFromNotification(initial.notification);
}
