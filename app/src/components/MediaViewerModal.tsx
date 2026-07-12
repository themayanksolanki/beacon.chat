import { useEffect, useRef, useState } from "react";
import {
  Dimensions,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export interface ViewerMedia {
  type: "image" | "video";
  uri: string;
}

interface Props {
  /** Every viewable item in this message's album (see ChatScreen's AlbumBubble) — a lone tap on a non-grouped bubble is just a 1-item gallery. */
  items: ViewerMedia[];
  /** Which item the tap that opened this gallery landed on. */
  initialIndex: number;
  onClose: () => void;
}

const THUMB_SIZE = 44;
const THUMB_GAP = 8;

function GalleryImagePage({ uri, width }: { uri: string; width: number }) {
  return (
    <View style={[styles.page, { width }]}>
      <Image source={{ uri }} style={styles.pageMedia} resizeMode="contain" />
    </View>
  );
}

function GalleryVideoPage({ uri, width, active }: { uri: string; width: number; active: boolean }) {
  // Always called (never conditionally) — same pattern as VideoMessageBubble/
  // AlbumGrid's players — only whether it's playing depends on `active`, not
  // whether the hook itself runs.
  const player = useVideoPlayer(uri);
  useEffect(() => {
    if (active) player.play();
    else player.pause();
  }, [active, player]);

  return (
    <View style={[styles.page, { width }]}>
      <VideoView player={player} style={styles.pageMedia} nativeControls contentFit="contain" />
    </View>
  );
}

function GalleryThumb({
  item,
  active,
  onPress,
}: {
  item: ViewerMedia;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.thumb, active && styles.thumbActive]} onPress={onPress}>
      <Image source={{ uri: item.uri }} style={styles.thumbImage} resizeMode="cover" />
      {item.type === "video" ? (
        <View style={styles.thumbPlayBadge} pointerEvents="none">
          <Ionicons name="play" size={12} color="#fff" />
        </View>
      ) : null}
    </Pressable>
  );
}

/** Full-screen gallery opened by tapping an image/video bubble or an album
 * grid cell (see ChatScreen's AlbumBubble) — swipe through every item in the
 * batch, WhatsApp-style, with a tap-to-jump thumbnail strip along the
 * bottom. A single non-grouped bubble just opens a 1-item gallery. */
export default function MediaViewerModal({ items, initialIndex, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [{ width: screenWidth }] = useState(() => Dimensions.get("window"));
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const listRef = useRef<FlatList<ViewerMedia>>(null);
  const thumbListRef = useRef<FlatList<ViewerMedia>>(null);
  const visible = items.length > 0;

  // Reset to whatever item was actually tapped each time a new gallery opens
  // — this component instance is shared/reused across opens (see ChatScreen),
  // so state from a previous gallery would otherwise linger.
  useEffect(() => {
    if (visible) setActiveIndex(initialIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-sync when a *new* gallery opens (items identity/initialIndex), not on every activeIndex change this component itself causes
  }, [visible, initialIndex, items]);

  const jumpTo = (index: number) => {
    setActiveIndex(index);
    listRef.current?.scrollToIndex({ index, animated: true });
  };

  const onMomentumScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = Math.round(e.nativeEvent.contentOffset.x / screenWidth);
    setActiveIndex(index);
    if (items.length > 1) {
      thumbListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        {visible ? (
          <FlatList
            ref={listRef}
            data={items}
            keyExtractor={(_, index) => String(index)}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={initialIndex}
            getItemLayout={(_, index) => ({ length: screenWidth, offset: screenWidth * index, index })}
            onMomentumScrollEnd={onMomentumScrollEnd}
            onScrollToIndexFailed={({ index }) =>
              listRef.current?.scrollToOffset({ offset: screenWidth * index, animated: false })
            }
            renderItem={({ item, index }) =>
              item.type === "video" ? (
                <GalleryVideoPage uri={item.uri} width={screenWidth} active={index === activeIndex} />
              ) : (
                <GalleryImagePage uri={item.uri} width={screenWidth} />
              )
            }
          />
        ) : null}

        {items.length > 1 ? (
          <View style={[styles.counterWrap, { top: insets.top + 14 }]} pointerEvents="none">
            <Text style={styles.counterText}>
              {activeIndex + 1} / {items.length}
            </Text>
          </View>
        ) : null}

        <Pressable style={[styles.closeButton, { top: insets.top + 10 }]} onPress={onClose} hitSlop={10}>
          <Ionicons name="close" size={26} color="#fff" />
        </Pressable>

        {items.length > 1 ? (
          <View style={[styles.thumbStrip, { paddingBottom: insets.bottom + 10 }]}>
            <FlatList
              ref={thumbListRef}
              data={items}
              keyExtractor={(_, index) => String(index)}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.thumbStripContent}
              getItemLayout={(_, index) => ({
                length: THUMB_SIZE + THUMB_GAP,
                offset: (THUMB_SIZE + THUMB_GAP) * index,
                index,
              })}
              onScrollToIndexFailed={() => {}}
              renderItem={({ item, index }) => (
                <GalleryThumb item={item} active={index === activeIndex} onPress={() => jumpTo(index)} />
              )}
            />
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "#000" },
  page: { height: "100%", alignItems: "center", justifyContent: "center" },
  pageMedia: { width: "100%", height: "100%" },
  counterWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  counterText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
    backgroundColor: "rgba(0,0,0,0.45)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    overflow: "hidden",
  },
  closeButton: {
    position: "absolute",
    right: 14,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  thumbStrip: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.35)",
    paddingTop: 10,
  },
  thumbStripContent: { paddingHorizontal: 12, gap: THUMB_GAP },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: 8,
    overflow: "hidden",
    opacity: 0.5,
    borderWidth: 2,
    borderColor: "transparent",
  },
  thumbActive: { opacity: 1, borderColor: "#fff" },
  thumbImage: { width: "100%", height: "100%" },
  thumbPlayBadge: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.25)",
  },
});
