import { StyleSheet, Text, View } from "react-native";

export default function CallHistoryScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>No call history yet</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center" },
  text: { color: "#999" },
});
