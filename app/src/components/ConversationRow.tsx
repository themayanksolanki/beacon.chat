import { useMemo, useRef } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import type { ConversationSummary } from "../db/database";
import type { MessageMenuAnchor } from "./MessageActionMenu";
import { colorForName, initialFor, type ThemeColors } from "../theme";

export function formatListTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  const diffDays = (now.getTime() - date.getTime()) / 86_400_000;
  if (diffDays < 7) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Read-receipt tick shown before the preview text, only for our own last outgoing message. */
function PreviewReceiptTick({ item, colors }: { item: ConversationSummary; colors: ThemeColors }) {
  if (item.last_message_direction !== "outgoing") return null;
  if (item.last_message_status === "failed") {
    return <Ionicons name="alert-circle" size={13} color={colors.danger} style={rowStyles.receiptTick} />;
  }
  if (item.last_message_status === "read") {
    return <Ionicons name="checkmark-done" size={14} color={colors.accent} style={rowStyles.receiptTick} />;
  }
  if (item.last_message_status === "delivered") {
    return <Ionicons name="checkmark-done" size={14} color={colors.textTertiary} style={rowStyles.receiptTick} />;
  }
  return <Ionicons name="checkmark" size={14} color={colors.textTertiary} style={rowStyles.receiptTick} />;
}

/**
 * One chat-list row — shared by ConversationListScreen and
 * ArchivedChatsScreen (previously duplicated between the two). Renders
 * either the normal last-message preview or, for a still-pending contact
 * request, inline accept/reject buttons.
 */
export default function ConversationRow({
  item,
  isOnline,
  colors,
  onPress,
  onLongPressAt,
  onAccept,
  onReject,
}: {
  item: ConversationSummary;
  isOnline: boolean;
  colors: ThemeColors;
  onPress: () => void;
  onLongPressAt: (anchor: MessageMenuAnchor) => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const rowRef = useRef<View>(null);
  const name = item.display_name ?? "Unknown";
  const hasUnread = item.unread_count > 0;

  return (
    <Pressable
      ref={rowRef}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={onPress}
      onLongPress={() => {
        rowRef.current?.measureInWindow((x, y, width, height) => {
          onLongPressAt({ x, y, width, height });
        });
      }}
    >
      <View style={styles.avatar}>
        {item.avatar_url ? (
          <Image source={{ uri: item.avatar_url }} style={StyleSheet.absoluteFill} />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.avatarFallback, { backgroundColor: colorForName(name) }]}>
            <Text style={styles.avatarText}>{initialFor(name)}</Text>
          </View>
        )}
        {isOnline ? <View style={styles.onlineDot} /> : null}
      </View>
      <View style={styles.rowContent}>
        <View style={styles.rowTop}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          {item.last_message_at ? (
            <Text style={[styles.time, hasUnread && styles.timeUnread]}>
              {formatListTimestamp(item.last_message_at)}
            </Text>
          ) : null}
        </View>
        <View style={styles.rowBottom}>
          {item.status === "pending_incoming" ? (
            <>
              <Text style={styles.requestLabel} numberOfLines={1}>
                Wants to message you
              </Text>
              <View style={styles.requestActions}>
                <Pressable
                  style={[styles.requestButton, styles.requestButtonAccept]}
                  onPress={onAccept}
                  hitSlop={6}
                >
                  <Ionicons name="checkmark" size={16} color={colors.tickRead} />
                </Pressable>
                <Pressable
                  style={[styles.requestButton, styles.requestButtonReject]}
                  onPress={onReject}
                  hitSlop={6}
                >
                  <Ionicons name="close" size={16} color={colors.danger} />
                </Pressable>
              </View>
            </>
          ) : item.status === "pending_outgoing" ? (
            <Text style={styles.requestLabel} numberOfLines={1}>
              Request sent
            </Text>
          ) : item.status === "declined" ? (
            <Text style={styles.requestLabel} numberOfLines={1}>
              Declined
            </Text>
          ) : (
            <>
              <View style={styles.previewRow}>
                <PreviewReceiptTick item={item} colors={colors} />
                <Text style={[styles.preview, hasUnread && styles.previewUnread]} numberOfLines={1}>
                  {item.last_message ?? "No messages yet"}
                </Text>
              </View>
              {hasUnread ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{item.unread_count > 99 ? "99+" : item.unread_count}</Text>
                </View>
              ) : null}
            </>
          )}
        </View>
      </View>
    </Pressable>
  );
}

const rowStyles = StyleSheet.create({
  receiptTick: { marginRight: 3 },
});

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 12,
      borderRadius: 18,
      backgroundColor: colors.surface,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 3,
      elevation: 1,
    },
    cardPressed: { opacity: 0.7 },
    avatar: { width: 56, height: 56, borderRadius: 28, overflow: "hidden" },
    avatarFallback: { alignItems: "center", justifyContent: "center" },
    avatarText: { fontSize: 20, fontWeight: "700", color: "#fff" },
    onlineDot: {
      position: "absolute",
      bottom: 1,
      right: 1,
      width: 14,
      height: 14,
      borderRadius: 7,
      backgroundColor: colors.tickRead,
      borderWidth: 2,
      borderColor: colors.surface,
    },
    rowContent: { flex: 1 },
    rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    name: { fontSize: 16, fontWeight: "700", color: colors.text, flexShrink: 1 },
    time: { fontSize: 12, color: colors.textTertiary },
    timeUnread: { color: colors.accent, fontWeight: "600" },
    rowBottom: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 3 },
    previewRow: { flex: 1, flexDirection: "row", alignItems: "center", marginRight: 8 },
    preview: { fontSize: 14, color: colors.textSecondary, flex: 1 },
    previewUnread: { color: colors.text, fontWeight: "500" },
    badge: {
      backgroundColor: colors.accent,
      borderRadius: 10,
      minWidth: 20,
      height: 20,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 6,
    },
    badgeText: { color: "#fff", fontSize: 12, fontWeight: "700" },
    requestLabel: { flex: 1, fontSize: 14, color: colors.textTertiary, fontStyle: "italic" },
    requestActions: { flexDirection: "row", gap: 8 },
    requestButton: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
    },
    requestButtonAccept: { backgroundColor: colors.tickRead + "22", borderColor: colors.tickRead },
    requestButtonReject: { backgroundColor: colors.danger + "22", borderColor: colors.danger },
  });
