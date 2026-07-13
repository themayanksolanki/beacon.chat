import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";

import { useTheme } from "../ThemeContext";

const GAP = 2;

export interface AlbumCellData {
  id: string;
  kind: "image" | "video";
  /** Local uri to render. Null means "not available yet" — an undownloaded
   * video (tap to download) or a tombstoned item — rendered as a muted
   * placeholder with no interaction. */
  uri: string | null;
  isSending: boolean;
  uploadProgress?: number;
  onPress?: () => void;
  onLongPress?: () => void;
  onCancelSend?: () => void;
  /** Only set on the last visible cell when the album has more items than are shown. */
  extraCount?: number;
  /** True while the chat is in forward-selection mode — swaps the cell's tap behavior to toggle selection (see ChatScreen) and shows the checkmark overlay below. */
  selectable?: boolean;
  selected?: boolean;
}

interface CellProps {
  cell: AlbumCellData;
  width: number;
  height: number;
}

function CellOverlays({ cell }: { cell: AlbumCellData }) {
  const { colors } = useTheme();
  return (
    <>
      {cell.selectable ? (
        <View style={styles.selectionOverlay} pointerEvents="none">
          <Ionicons
            name={cell.selected ? "checkmark-circle" : "ellipse-outline"}
            size={22}
            color={cell.selected ? colors.accent : "#fff"}
          />
        </View>
      ) : null}
      {cell.isSending ? (
        <View style={styles.sendingOverlay} pointerEvents={cell.onCancelSend ? "box-none" : "none"}>
          <ActivityIndicator color="#fff" size="small" />
          {cell.uploadProgress != null ? (
            <Text style={styles.sendingText}>{Math.round(cell.uploadProgress * 100)}%</Text>
          ) : null}
          {cell.onCancelSend ? (
            <Pressable style={styles.cancelButton} onPress={cell.onCancelSend} hitSlop={8}>
              <Ionicons name="close" size={14} color="#fff" />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {cell.extraCount && cell.extraCount > 0 ? (
        <View style={styles.extraOverlay} pointerEvents="none">
          <Text style={styles.extraOverlayText}>+{cell.extraCount}</Text>
        </View>
      ) : null}
    </>
  );
}

function ImageCell({ cell, width, height }: CellProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      style={[styles.cell, { width, height }]}
      onPress={cell.onPress}
      onLongPress={cell.onLongPress}
      disabled={!cell.onPress && !cell.onLongPress}
    >
      {cell.uri ? (
        <Image source={{ uri: cell.uri }} style={styles.cellMedia} resizeMode="cover" />
      ) : (
        <View style={[styles.cellMedia, styles.cellPlaceholder, { backgroundColor: colors.bubbleIncoming }]}>
          <Ionicons name="image-outline" size={22} color={colors.textTertiary} />
        </View>
      )}
      <CellOverlays cell={cell} />
    </Pressable>
  );
}

function VideoCell({ cell, width, height }: CellProps) {
  const { colors } = useTheme();
  // Always called (never conditionally), even when cell.uri is null — same
  // pattern as VideoMessageBubble's player, just holding a null source until
  // a uri is available.
  const player = useVideoPlayer(cell.uri ?? null);
  return (
    <Pressable
      style={[styles.cell, { width, height }]}
      onPress={cell.onPress}
      onLongPress={cell.onLongPress}
      disabled={!cell.onPress && !cell.onLongPress}
    >
      {cell.uri ? (
        <>
          <VideoView player={player} style={styles.cellMedia} nativeControls={false} contentFit="cover" />
          {!cell.isSending ? (
            <View style={styles.playIconWrap} pointerEvents="none">
              <Ionicons name="play-circle" size={28} color="rgba(255,255,255,0.9)" />
            </View>
          ) : null}
        </>
      ) : (
        <View style={[styles.cellMedia, styles.cellPlaceholder, { backgroundColor: colors.bubbleIncoming }]}>
          <Ionicons name="play-circle-outline" size={22} color={colors.textTertiary} />
        </View>
      )}
      <CellOverlays cell={cell} />
    </Pressable>
  );
}

function renderCell(cell: AlbumCellData, width: number, height: number) {
  return cell.kind === "video" ? (
    <VideoCell key={cell.id} cell={cell} width={width} height={height} />
  ) : (
    <ImageCell key={cell.id} cell={cell} width={width} height={height} />
  );
}

interface Props {
  cells: AlbumCellData[];
  /** Square side of the whole grid. */
  size?: number;
}

/** WhatsApp-style media grid: up to 4 visible cells, the 4th overlaid with
 * "+N" when the underlying batch (see ChatScreen's album_id grouping) has
 * more than 4 items. */
export default function AlbumGrid({ cells, size = 220 }: Props) {
  const visible = cells.slice(0, 4);
  if (visible.length === 0) return null;
  const half = (size - GAP) / 2;

  let content;
  if (visible.length === 1) {
    content = renderCell(visible[0], size, size);
  } else if (visible.length === 2) {
    content = (
      <View style={styles.row}>
        {renderCell(visible[0], half, size)}
        <View style={{ width: GAP }} />
        {renderCell(visible[1], half, size)}
      </View>
    );
  } else if (visible.length === 3) {
    content = (
      <View style={styles.row}>
        {renderCell(visible[0], half, size)}
        <View style={{ width: GAP }} />
        <View>
          {renderCell(visible[1], half, half)}
          <View style={{ height: GAP }} />
          {renderCell(visible[2], half, half)}
        </View>
      </View>
    );
  } else {
    content = (
      <View>
        <View style={styles.row}>
          {renderCell(visible[0], half, half)}
          <View style={{ width: GAP }} />
          {renderCell(visible[1], half, half)}
        </View>
        <View style={{ height: GAP }} />
        <View style={styles.row}>
          {renderCell(visible[2], half, half)}
          <View style={{ width: GAP }} />
          {renderCell(visible[3], half, half)}
        </View>
      </View>
    );
  }

  return <View style={[styles.container, { width: size, height: size }]}>{content}</View>;
}

const styles = StyleSheet.create({
  container: { borderRadius: 14, overflow: "hidden" },
  row: { flexDirection: "row" },
  cell: { overflow: "hidden" },
  cellMedia: { width: "100%", height: "100%" },
  cellPlaceholder: { alignItems: "center", justifyContent: "center" },
  playIconWrap: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  sendingOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  sendingText: { color: "#fff", fontSize: 10, fontWeight: "700", marginTop: 4 },
  cancelButton: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  extraOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  extraOverlayText: { color: "#fff", fontSize: 22, fontWeight: "700" },
  selectionOverlay: {
    position: "absolute",
    top: 6,
    right: 6,
  },
});
