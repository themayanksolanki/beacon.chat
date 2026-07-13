import { useEffect, useMemo, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text } from "react-native";

import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

const AUTO_DISMISS_MS = 4000;

interface Props {
  visible: boolean;
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
}

/** Brief bottom banner with an Undo action — used for reversible actions like archiving, where a blocking confirm dialog would just be extra friction. */
export default function UndoSnackbar({ visible, message, onUndo, onDismiss }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const translateY = useRef(new Animated.Value(80)).current;

  useEffect(() => {
    if (!visible) return;
    Animated.spring(translateY, { toValue: 0, friction: 9, tension: 80, useNativeDriver: true }).start();
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onDismiss is a fresh closure each render; re-running the timer on that alone would keep resetting it
  }, [visible, translateY]);

  if (!visible) return null;

  return (
    <Animated.View style={[styles.wrap, { transform: [{ translateY }] }]}>
      <Text style={styles.message} numberOfLines={1}>
        {message}
      </Text>
      <Pressable
        onPress={() => {
          onUndo();
          onDismiss();
        }}
        hitSlop={8}
      >
        <Text style={styles.undo}>UNDO</Text>
      </Pressable>
    </Animated.View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    wrap: {
      position: "absolute",
      left: 16,
      right: 16,
      bottom: 24,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      backgroundColor: colors.text,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 16,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.2,
      shadowRadius: 10,
      elevation: 6,
    },
    message: { flex: 1, color: colors.background, fontSize: 14 },
    undo: { color: colors.accent, fontSize: 14, fontWeight: "700" },
  });
