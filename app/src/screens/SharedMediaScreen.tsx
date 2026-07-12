import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Alert, Dimensions, FlatList, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";

import type { MainStackParamList } from "../../App";
import { deleteMessage, getMediaMessages, type MessageRow } from "../db/database";
import MediaViewerModal, { type ViewerMedia } from "../components/MediaViewerModal";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

type Props = NativeStackScreenProps<MainStackParamList, "SharedMedia">;

type Tab = "media" | "links" | "docs";

const NUM_COLUMNS = 4;
const CELL_GAP = 2;

function mediaUri(message: MessageRow): string | null {
  if (message.kind === "video") return message.video_uri;
  if (message.kind === "gif") return message.gif_url;
  return message.image_uri;
}

function GridVideoCell({ uri, size }: { uri: string; size: number }) {
  // Always called (never conditionally) — same pattern as VideoMessageBubble/
  // AlbumGrid's players, just a static paused preview frame here.
  const player = useVideoPlayer(uri);
  return (
    <View style={{ width: size, height: size }}>
      <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls={false} contentFit="cover" />
      <View style={styles.playBadge} pointerEvents="none">
        <Ionicons name="play" size={14} color="#fff" />
      </View>
    </View>
  );
}

export default function SharedMediaScreen({ route, navigation }: Props) {
  const { conversationId } = route.params;
  const { colors } = useTheme();
  const themedStyles = useMemo(() => createStyles(colors), [colors]);
  const [media, setMedia] = useState<MessageRow[]>([]);
  const [tab, setTab] = useState<Tab>("media");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);

  useFocusEffect(
    useCallback(() => {
      setMedia(getMediaMessages(conversationId));
    }, [conversationId])
  );

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  // Selection only applies to the media grid — leaving that tab mid-selection
  // would otherwise strand the header in "N selected"/Delete mode over a
  // Links/Docs placeholder that has nothing to do with it.
  useEffect(() => {
    if (tab !== "media") exitSelectionMode();
  }, [tab, exitSelectionMode]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const confirmDeleteSelected = useCallback(() => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    Alert.alert("Delete media", `Delete ${ids.length} item${ids.length === 1 ? "" : "s"}? This can't be undone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          const idSet = new Set(ids);
          for (const id of ids) deleteMessage(id);
          setMedia((prev) => prev.filter((m) => !idSet.has(m.id)));
          exitSelectionMode();
        },
      },
    ]);
  }, [selectedIds, exitSelectionMode]);

  // Only media with a resolvable local/remote uri can actually be opened in
  // the gallery (an undownloaded video has neither) — readyIndexByMessageId
  // maps a grid cell's message id to its position in that filtered set, so
  // tapping a cell lands the viewer on the right page.
  const { readyItems, readyIndexByMessageId } = useMemo(() => {
    const items: ViewerMedia[] = [];
    const indexById = new Map<string, number>();
    for (const message of media) {
      const uri = mediaUri(message);
      if (!uri) continue;
      indexById.set(message.id, items.length);
      items.push({ type: message.kind === "video" ? "video" : "image", uri });
    }
    return { readyItems: items, readyIndexByMessageId: indexById };
  }, [media]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: selectionMode
        ? () => (
            <Pressable onPress={exitSelectionMode} hitSlop={8} style={themedStyles.headerTextButton}>
              <Text style={themedStyles.headerButtonLabel}>Cancel</Text>
            </Pressable>
          )
        : undefined,
      headerTitle: selectionMode ? `${selectedIds.size} selected` : "Media, links and docs",
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
        : tab === "media" && media.length > 0
          ? () => (
              <Pressable onPress={() => setSelectionMode(true)} hitSlop={8} style={themedStyles.headerTextButton}>
                <Text style={themedStyles.headerButtonLabel}>Select</Text>
              </Pressable>
            )
          : undefined,
    });
  }, [
    navigation,
    selectionMode,
    selectedIds,
    colors,
    tab,
    media.length,
    exitSelectionMode,
    confirmDeleteSelected,
    themedStyles,
  ]);

  const [{ width: screenWidth }] = useState(() => Dimensions.get("window"));
  const cellSize = (screenWidth - CELL_GAP * (NUM_COLUMNS - 1)) / NUM_COLUMNS;
  const imageCount = media.filter((m) => m.kind !== "video").length;
  const videoCount = media.filter((m) => m.kind === "video").length;

  return (
    <View style={themedStyles.container}>
      <View style={themedStyles.tabRow}>
        {(["media", "links", "docs"] as Tab[]).map((t) => (
          <Pressable
            key={t}
            style={[themedStyles.tabButton, tab === t && themedStyles.tabButtonActive]}
            onPress={() => setTab(t)}
          >
            <Text style={[themedStyles.tabLabel, tab === t && themedStyles.tabLabelActive]}>
              {t === "media" ? "Media" : t === "links" ? "Links" : "Docs"}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab !== "media" ? (
        <View style={themedStyles.empty}>
          <Ionicons
            name={tab === "links" ? "link-outline" : "document-text-outline"}
            size={40}
            color={colors.textTertiary}
          />
          <Text style={themedStyles.emptyText}>{tab === "links" ? "Links" : "Docs"} coming soon</Text>
        </View>
      ) : media.length === 0 ? (
        <View style={themedStyles.empty}>
          <Ionicons name="images-outline" size={40} color={colors.textTertiary} />
          <Text style={themedStyles.emptyText}>No media shared yet</Text>
        </View>
      ) : (
        <FlatList
          data={media}
          keyExtractor={(item) => item.id}
          numColumns={NUM_COLUMNS}
          columnWrapperStyle={{ gap: CELL_GAP }}
          contentContainerStyle={{ gap: CELL_GAP }}
          renderItem={({ item }) => {
            const uri = mediaUri(item);
            const isSelected = selectedIds.has(item.id);
            const readyIndex = readyIndexByMessageId.get(item.id);
            return (
              <Pressable
                style={{ width: cellSize, height: cellSize }}
                onPress={() => {
                  if (selectionMode) {
                    toggleSelected(item.id);
                    return;
                  }
                  if (readyIndex !== undefined) {
                    setViewerIndex(readyIndex);
                    setViewerOpen(true);
                  }
                }}
                onLongPress={() => {
                  if (!selectionMode) {
                    setSelectionMode(true);
                    toggleSelected(item.id);
                  }
                }}
              >
                {uri ? (
                  item.kind === "video" ? (
                    <GridVideoCell uri={uri} size={cellSize} />
                  ) : (
                    <Image source={{ uri }} style={{ width: cellSize, height: cellSize }} resizeMode="cover" />
                  )
                ) : (
                  <View style={[{ width: cellSize, height: cellSize }, themedStyles.placeholderCell]}>
                    <Ionicons
                      name={item.kind === "video" ? "videocam-outline" : "image-outline"}
                      size={20}
                      color={colors.textTertiary}
                    />
                  </View>
                )}
                {selectionMode ? (
                  <View style={themedStyles.selectionOverlay} pointerEvents="none">
                    <Ionicons
                      name={isSelected ? "checkmark-circle" : "ellipse-outline"}
                      size={22}
                      color={isSelected ? colors.accent : "#fff"}
                    />
                  </View>
                ) : null}
              </Pressable>
            );
          }}
          ListFooterComponent={
            <Text style={themedStyles.footerText}>
              {imageCount} Photo{imageCount === 1 ? "" : "s"}, {videoCount} Video{videoCount === 1 ? "" : "s"}
            </Text>
          }
        />
      )}

      <MediaViewerModal
        items={viewerOpen ? readyItems : []}
        initialIndex={viewerIndex}
        onClose={() => setViewerOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  playBadge: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.15)",
  },
});

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    tabRow: {
      flexDirection: "row",
      backgroundColor: colors.surface,
      borderRadius: 10,
      margin: 12,
      padding: 3,
      gap: 3,
    },
    tabButton: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 8 },
    tabButtonActive: { backgroundColor: colors.accent },
    tabLabel: { fontSize: 14, fontWeight: "600", color: colors.textSecondary },
    tabLabelActive: { color: "#fff" },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
    emptyText: { color: colors.textTertiary, fontSize: 15 },
    placeholderCell: { backgroundColor: colors.bubbleIncoming, alignItems: "center", justifyContent: "center" },
    selectionOverlay: {
      position: "absolute",
      top: 6,
      right: 6,
    },
    footerText: {
      textAlign: "center",
      color: colors.textTertiary,
      fontSize: 13,
      paddingVertical: 16,
    },
    headerTextButton: { paddingHorizontal: 4, paddingVertical: 4 },
    headerButtonLabel: { fontSize: 16, color: colors.accent },
  });
