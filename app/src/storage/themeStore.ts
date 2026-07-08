import * as SecureStore from "expo-secure-store";

const THEME_PREFERENCE_ALIAS = "beacon.theme.preference";

export type ThemePreference = "system" | "light" | "dark";

const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function loadThemePreference(): Promise<ThemePreference> {
  const stored = await SecureStore.getItemAsync(THEME_PREFERENCE_ALIAS, secureOptions);
  return stored === "light" || stored === "dark" ? stored : "system";
}

export async function saveThemePreference(preference: ThemePreference): Promise<void> {
  await SecureStore.setItemAsync(THEME_PREFERENCE_ALIAS, preference, secureOptions);
}
