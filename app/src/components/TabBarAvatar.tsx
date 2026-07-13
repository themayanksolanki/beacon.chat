import { Image, StyleSheet, Text, View } from "react-native";

import { useAuth } from "../auth/AuthContext";
import { colorForName, initialFor } from "../theme";

type Props = {
  focused: boolean;
  color: string;
  size: number;
};

export default function TabBarAvatar({ focused, color, size }: Props) {
  const { profile } = useAuth();
  const dimension = size + 4;

  return (
    <View
      style={[
        styles.ring,
        {
          width: dimension + 4,
          height: dimension + 4,
          borderRadius: (dimension + 4) / 2,
          borderColor: focused ? color : "transparent",
        },
      ]}
    >
      {profile?.photoUri ? (
        <Image
          source={{ uri: profile.photoUri }}
          style={{ width: dimension, height: dimension, borderRadius: dimension / 2 }}
        />
      ) : (
        <View
          style={[
            styles.placeholder,
            {
              width: dimension,
              height: dimension,
              borderRadius: dimension / 2,
              backgroundColor: colorForName(profile?.fullName ?? "?"),
            },
          ]}
        >
          <Text style={[styles.initial, { fontSize: dimension * 0.42 }]}>{initialFor(profile?.fullName)}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  ring: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
  },
  placeholder: { alignItems: "center", justifyContent: "center" },
  initial: { fontWeight: "700", color: "#fff" },
});
