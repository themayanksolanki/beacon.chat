import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { CompositeScreenProps } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";

import type { MainStackParamList, MainTabParamList } from "../../App";
import { useCall } from "../calls/CallContext";
import { deleteCall, deleteCalls, getCallHistory, type CallHistoryEntry } from "../db/database";
import MessageActionMenu, { type MessageAction, type MessageMenuAnchor } from "../components/MessageActionMenu";
import { useTheme } from "../ThemeContext";
import { colorForName, initialFor, type ThemeColors } from "../theme";

type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, "CallHistory">,
  NativeStackScreenProps<MainStackParamList>
>;

function formatCallTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatCallDuration(entry: CallHistoryEntry): string | null {
  if (entry.status !== "completed" || !entry.answered_at || !entry.ended_at) return null;
  const totalSeconds = Math.max(0, Math.round((entry.ended_at - entry.answered_at) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function CallDirectionIcon({ entry, colors }: { entry: CallHistoryEntry; colors: ThemeColors }) {
  if (entry.status === "missed" || entry.status === "declined" || entry.status === "failed") {
    return <Ionicons name="arrow-down-outline" size={13} color={colors.danger} style={styles.directionIcon} />;
  }
  if (entry.direction === "outgoing") {
    return <Ionicons name="arrow-up-outline" size={13} color={colors.textTertiary} style={styles.directionIcon} />;
  }
  return <Ionicons name="arrow-down-outline" size={13} color={colors.textTertiary} style={styles.directionIcon} />;
}

function statusLabel(entry: CallHistoryEntry): string {
  if (entry.status === "missed") return entry.direction === "incoming" ? "Missed" : "No answer";
  if (entry.status === "declined") return "Declined";
  if (entry.status === "failed") return "Call failed";
  const duration = formatCallDuration(entry);
  return duration ?? "Completed";
}

export default function CallHistoryScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const themedStyles = useMemo(() => createStyles(colors), [colors]);
  const { startCall } = useCall();
  const [history, setHistory] = useState<CallHistoryEntry[]>([]);
  const rowRefs = useRef<Map<string, View>>(new Map());
  const overflowButtonRef = useRef<View>(null);
  const [menu, setMenu] = useState<{
    entry: CallHistoryEntry;
    actions: MessageAction[];
    anchor: MessageMenuAnchor;
  } | null>(null);
  const [overflowMenu, setOverflowMenu] = useState<{ actions: MessageAction[]; anchor: MessageMenuAnchor } | null>(
    null
  );

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useFocusEffect(
    useCallback(() => {
      setHistory(getCallHistory());
    }, [])
  );

  // Search matches the peer's display name — the only thing shown per row
  // besides call metadata, so it's the only reasonable thing to search by.
  const filteredHistory = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return history;
    return history.filter((entry) => (entry.display_name ?? "Unknown").toLowerCase().includes(query));
  }, [history, searchQuery]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  // "Select All" seeds selection mode with every currently-*visible* (i.e.
  // search-filtered) entry checked — the user can then deselect individual
  // ones before deleting, or just tap Delete straight away for a true
  // select-everything-filtered delete.
  const selectAllFiltered = useCallback(() => {
    setSelectionMode(true);
    setSelectedIds(new Set(filteredHistory.map((entry) => entry.id)));
  }, [filteredHistory]);

  const confirmDeleteSelected = useCallback(() => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    Alert.alert("Delete calls", `Delete ${ids.length} selected call${ids.length === 1 ? "" : "s"}? This can't be undone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          deleteCalls(ids);
          setHistory((prev) => prev.filter((entry) => !selectedIds.has(entry.id)));
          exitSelectionMode();
        },
      },
    ]);
  }, [selectedIds, exitSelectionMode]);

  // Deletes every currently-*visible* entry outright (respecting the active
  // search filter) without needing to go through selection mode first.
  const confirmDeleteAllFiltered = useCallback(() => {
    const ids = filteredHistory.map((entry) => entry.id);
    if (ids.length === 0) return;
    const query = searchQuery.trim();
    Alert.alert(
      "Delete all calls",
      query
        ? `Delete all ${ids.length} call${ids.length === 1 ? "" : "s"} matching "${query}"? This can't be undone.`
        : `Delete all ${ids.length} call${ids.length === 1 ? "" : "s"}? This can't be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            const idSet = new Set(ids);
            deleteCalls(ids);
            setHistory((prev) => prev.filter((entry) => !idSet.has(entry.id)));
          },
        },
      ]
    );
  }, [filteredHistory, searchQuery]);

  const openOverflowMenu = useCallback(() => {
    overflowButtonRef.current?.measureInWindow((x, y, width, height) => {
      const actions: MessageAction[] = [
        { label: "Select All", icon: "checkmark-done-outline", onPress: selectAllFiltered },
        { label: "Delete All", icon: "trash-outline", destructive: true, onPress: confirmDeleteAllFiltered },
      ];
      setOverflowMenu({ actions, anchor: { x, y, width, height } });
    });
  }, [selectAllFiltered, confirmDeleteAllFiltered]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openMenuFor = useCallback(
    (entry: CallHistoryEntry) => {
      const row = rowRefs.current.get(entry.id);
      row?.measureInWindow((x, y, width, height) => {
        const actions: MessageAction[] = [
          {
            label: "Call",
            icon: entry.kind === "video" ? "videocam-outline" : "call-outline",
            onPress: () => startCall(entry.conversation_id, entry.kind),
          },
          {
            label: "Message",
            icon: "chatbubble-outline",
            onPress: () => navigation.navigate("Chat", { conversationId: entry.conversation_id }),
          },
          {
            label: "Delete",
            icon: "trash-outline",
            destructive: true,
            onPress: () => {
              deleteCall(entry.id);
              setHistory((prev) => prev.filter((row) => row.id !== entry.id));
            },
          },
        ];
        setMenu({ entry, actions, anchor: { x, y, width, height } });
      });
    },
    [navigation, startCall]
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: selectionMode
        ? () => (
            <Pressable onPress={exitSelectionMode} hitSlop={8} style={themedStyles.headerTextButton}>
              <Text style={themedStyles.headerButtonLabel}>Cancel</Text>
            </Pressable>
          )
        : undefined,
      headerTitle: selectionMode ? `${selectedIds.size} selected` : "Call History",
      headerRight: selectionMode
        ? () => (
            <Pressable
              onPress={confirmDeleteSelected}
              disabled={selectedIds.size === 0}
              hitSlop={8}
              style={themedStyles.headerTextButton}
            >
              <Text
                style={[
                  themedStyles.headerButtonLabel,
                  { color: selectedIds.size === 0 ? colors.textTertiary : colors.danger },
                ]}
              >
                Delete
              </Text>
            </Pressable>
          )
        : () => (
            <View style={themedStyles.headerIconsRow}>
              <Pressable
                onPress={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
                hitSlop={8}
              >
                <Ionicons name={searchOpen ? "close" : "search"} size={22} color={colors.text} />
              </Pressable>
              <Pressable ref={overflowButtonRef} onPress={openOverflowMenu} hitSlop={8}>
                <Ionicons name="ellipsis-vertical" size={20} color={colors.text} />
              </Pressable>
            </View>
          ),
    });
  }, [
    navigation,
    selectionMode,
    selectedIds,
    searchOpen,
    colors,
    themedStyles,
    exitSelectionMode,
    confirmDeleteSelected,
    closeSearch,
    openOverflowMenu,
  ]);

  return (
    <View style={themedStyles.container}>
      {searchOpen ? (
        <View style={themedStyles.searchBar}>
          <Ionicons name="search" size={16} color={colors.textTertiary} />
          <TextInput
            autoFocus
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search by name"
            placeholderTextColor={colors.textTertiary}
            style={themedStyles.searchInput}
          />
          {searchQuery ? (
            <Pressable onPress={() => setSearchQuery("")} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {filteredHistory.length === 0 ? (
        <View style={themedStyles.center}>
          <Ionicons name="call-outline" size={36} color={colors.textTertiary} />
          <Text style={themedStyles.empty}>
            {history.length === 0 ? "No call history yet" : "No calls match your search"}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filteredHistory}
          keyExtractor={(item) => item.id}
          contentContainerStyle={themedStyles.list}
          renderItem={({ item }) => {
            const name = item.display_name ?? "Unknown";
            const isMissedLike = item.status === "missed" || item.status === "declined" || item.status === "failed";
            const isSelected = selectedIds.has(item.id);
            return (
              <Pressable
                ref={(el) => {
                  if (el) rowRefs.current.set(item.id, el);
                  else rowRefs.current.delete(item.id);
                }}
                style={themedStyles.row}
                onPress={() =>
                  selectionMode
                    ? toggleSelected(item.id)
                    : navigation.navigate("Chat", { conversationId: item.conversation_id })
                }
                onLongPress={selectionMode ? undefined : () => openMenuFor(item)}
              >
                {selectionMode ? (
                  <Ionicons
                    name={isSelected ? "checkmark-circle" : "ellipse-outline"}
                    size={22}
                    color={isSelected ? colors.accent : colors.textTertiary}
                  />
                ) : null}
                <View style={[themedStyles.avatar, { backgroundColor: colorForName(name) }]}>
                  <Text style={themedStyles.avatarText}>{initialFor(name)}</Text>
                </View>
                <View style={themedStyles.info}>
                  <Text style={[themedStyles.name, isMissedLike && themedStyles.nameMissed]} numberOfLines={1}>
                    {name}
                  </Text>
                  <View style={themedStyles.statusRow}>
                    <CallDirectionIcon entry={item} colors={colors} />
                    <Text style={themedStyles.status} numberOfLines={1}>
                      {statusLabel(item)}
                    </Text>
                  </View>
                </View>
                <Text style={themedStyles.time}>{formatCallTimestamp(item.started_at)}</Text>
                {!selectionMode ? (
                  <Pressable
                    style={themedStyles.redialButton}
                    onPress={() => startCall(item.conversation_id, item.kind)}
                    hitSlop={8}
                  >
                    <Ionicons
                      name={item.kind === "video" ? "videocam-outline" : "call-outline"}
                      size={20}
                      color={colors.accent}
                    />
                  </Pressable>
                ) : null}
              </Pressable>
            );
          }}
        />
      )}

      <MessageActionMenu
        visible={!!menu}
        anchor={menu?.anchor ?? null}
        actions={menu?.actions ?? []}
        align="left"
        onClose={() => setMenu(null)}
      />

      <MessageActionMenu
        visible={!!overflowMenu}
        anchor={overflowMenu?.anchor ?? null}
        actions={overflowMenu?.actions ?? []}
        align="right"
        onClose={() => setOverflowMenu(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  directionIcon: { marginRight: 2 },
});

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
    empty: { color: colors.textTertiary },
    list: { padding: 12, gap: 2 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 12,
      paddingVertical: 10,
      gap: 12,
    },
    avatar: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
    avatarText: { fontSize: 17, fontWeight: "700", color: "#fff" },
    info: { flex: 1 },
    name: { fontSize: 16, fontWeight: "600", color: colors.text },
    nameMissed: { color: colors.danger },
    statusRow: { flexDirection: "row", alignItems: "center", marginTop: 2 },
    status: { fontSize: 13, color: colors.textSecondary },
    time: { fontSize: 12, color: colors.textTertiary, marginRight: 8 },
    redialButton: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.accentSoft,
    },
    headerIconsRow: { flexDirection: "row", alignItems: "center", gap: 18, marginRight: 4 },
    headerTextButton: { paddingHorizontal: 4, paddingVertical: 4 },
    headerButtonLabel: { fontSize: 16, color: colors.accent },
    searchBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginHorizontal: 12,
      marginTop: 10,
      marginBottom: 2,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 10,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    searchInput: { flex: 1, fontSize: 15, color: colors.text, padding: 0 },
  });
