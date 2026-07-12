import { useMemo, useRef, useState } from "react";
import { StyleSheet, TextInput, View, type NativeSyntheticEvent } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  GiphyContent,
  GiphyGridView,
  GiphyMediaType,
  type GiphyContentRequest,
  type GiphyMedia,
} from "@giphy/react-native-sdk";

import { mediaToPickedGif, type PickedGif } from "../media/gifPicker";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

export interface GifTrayProps {
  height: number;
  /** Which GIPHY catalog to browse — a sticker is fetched/sent through the
   * exact same PickedGif shape and message pipeline as a GIF (see
   * ChatScreen's sendGif), just a different content type in the picker. */
  mediaType: "gif" | "sticker";
  onSelectGif: (gif: PickedGif) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

function trendingFor(mediaType: "gif" | "sticker"): GiphyContentRequest {
  return mediaType === "sticker" ? GiphyContent.trendingStickers() : GiphyContent.trendingGifs();
}

// Inline GIF/sticker search tray, embedded in place of the keyboard (see
// ChatScreen's pickerOpen state) rather than the SDK's full-screen
// GiphyDialog modal — GiphyGridView is the SDK's plain, non-modal React
// component for this. There's no bundled search bar, so this pairs it with
// its own debounced TextInput, feeding a fresh GiphyContentRequest into the
// grid's `content` prop on every query change. The parent mounts a fresh
// instance per tab (key={mediaType}) rather than this reacting to prop
// changes itself, so switching tabs always starts from a clean trending feed.
export default function GifTray({ height, mediaType, onSelectGif }: GifTrayProps) {
  const { colors, scheme } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [query, setQuery] = useState("");
  const [content, setContent] = useState<GiphyContentRequest>(() => trendingFor(mediaType));
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChangeText = (text: string) => {
    setQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setContent(
        text.trim()
          ? GiphyContent.search({
              searchQuery: text.trim(),
              mediaType: mediaType === "sticker" ? GiphyMediaType.Sticker : GiphyMediaType.Gif,
            })
          : trendingFor(mediaType)
      );
    }, SEARCH_DEBOUNCE_MS);
  };

  const handleMediaSelect = (event: NativeSyntheticEvent<{ media: GiphyMedia }>) => {
    const gif = mediaToPickedGif(event.nativeEvent.media);
    if (gif) onSelectGif(gif);
  };

  return (
    <View style={[styles.container, { height }]}>
      <View style={styles.searchRow}>
        <Ionicons name="search" size={16} color={colors.textTertiary} />
        <TextInput
          style={styles.searchInput}
          placeholder={mediaType === "sticker" ? "Search stickers" : "Search GIFs"}
          placeholderTextColor={colors.textTertiary}
          value={query}
          onChangeText={handleChangeText}
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>
      <GiphyGridView
        style={styles.grid}
        content={content}
        spanCount={3}
        cellPadding={2}
        onMediaSelect={handleMediaSelect}
        theme={scheme}
      />
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { backgroundColor: colors.background },
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginHorizontal: 10,
      marginTop: 8,
      marginBottom: 4,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 10,
      backgroundColor: colors.bubbleIncoming,
    },
    searchInput: { flex: 1, fontSize: 15, color: colors.text, padding: 0 },
    grid: { flex: 1 },
  });
