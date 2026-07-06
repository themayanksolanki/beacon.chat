import { useEffect, useMemo, useRef } from "react";
import { Animated, Dimensions, Modal, Pressable, StyleSheet, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

export interface MessageAction {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  destructive?: boolean;
}

export interface MessageMenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const CARD_WIDTH = 220;
const SCREEN_MARGIN = 12;

interface Props {
  visible: boolean;
  anchor: MessageMenuAnchor | null;
  actions: MessageAction[];
  currentReaction?: string | null;
  onReact?: (emoji: string) => void;
  onClose: () => void;
}

export default function MessageActionMenu({ visible, anchor, actions, currentReaction, onReact, onClose }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.92)).current;

  useEffect(() => {
    if (!visible) return;
    opacity.setValue(0);
    scale.setValue(0.92);
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 140, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, friction: 8, tension: 90, useNativeDriver: true }),
    ]).start();
  }, [visible, opacity, scale]);

  if (!anchor) return null;

  const { height: screenHeight, width: screenWidth } = Dimensions.get("window");
  const reactionRowHeight = onReact ? 56 : 0;
  const cardHeight = actions.length * 46 + 16;
  const totalHeight = reactionRowHeight + 8 + cardHeight;

  const fitsBelow = anchor.y + anchor.height + totalHeight + SCREEN_MARGIN < screenHeight;
  const top = fitsBelow
    ? anchor.y + anchor.height + 8
    : Math.max(SCREEN_MARGIN, anchor.y - totalHeight - 8);

  const left = Math.min(
    Math.max(SCREEN_MARGIN, anchor.x + anchor.width / 2 - CARD_WIDTH / 2),
    screenWidth - CARD_WIDTH - SCREEN_MARGIN
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Animated.View style={[styles.menuWrap, { top, left, opacity, transform: [{ scale }] }]}>
          {onReact ? (
            <Pressable style={styles.reactionRow} onPress={(e) => e.stopPropagation()}>
              {QUICK_REACTIONS.map((emoji) => (
                <Pressable
                  key={emoji}
                  style={[styles.reactionButton, currentReaction === emoji && styles.reactionButtonActive]}
                  onPress={() => {
                    onReact(emoji);
                    onClose();
                  }}
                  hitSlop={4}
                >
                  <Text style={styles.reactionEmoji}>{emoji}</Text>
                </Pressable>
              ))}
            </Pressable>
          ) : null}

          <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
            {actions.map((action, index) => (
              <Pressable
                key={action.label}
                style={[styles.actionRow, index < actions.length - 1 && styles.actionRowDivider]}
                onPress={() => {
                  action.onPress();
                  onClose();
                }}
              >
                <Text style={[styles.actionLabel, action.destructive && styles.actionLabelDestructive]}>
                  {action.label}
                </Text>
                <Ionicons
                  name={action.icon}
                  size={18}
                  color={action.destructive ? colors.danger : colors.textSecondary}
                />
              </Pressable>
            ))}
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
    menuWrap: { position: "absolute", width: CARD_WIDTH },
    reactionRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: colors.surface,
      borderRadius: 28,
      paddingHorizontal: 10,
      paddingVertical: 8,
      marginBottom: 8,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.15,
      shadowRadius: 10,
      elevation: 6,
    },
    reactionButton: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: "center",
      justifyContent: "center",
    },
    reactionButtonActive: { backgroundColor: colors.accentSoft },
    reactionEmoji: { fontSize: 20 },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      overflow: "hidden",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.15,
      shadowRadius: 10,
      elevation: 6,
    },
    actionRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    actionRowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    actionLabel: { fontSize: 15.5, color: colors.text },
    actionLabelDestructive: { color: colors.danger },
  });
