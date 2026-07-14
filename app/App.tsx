import { ActivityIndicator, StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import {
  DarkTheme as NavDarkTheme,
  DefaultTheme as NavDefaultTheme,
  NavigationContainer,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";

import ConversationListScreen from "./src/screens/ConversationListScreen";
import CallHistoryScreen from "./src/screens/CallHistoryScreen";
import ChatScreen from "./src/screens/ChatScreen";
import ContactsScreen from "./src/screens/ContactsScreen";
import ArchivedChatsScreen from "./src/screens/ArchivedChatsScreen";
import ContactInfoScreen from "./src/screens/ContactInfoScreen";
import SharedMediaScreen from "./src/screens/SharedMediaScreen";
import ForwardScreen from "./src/screens/ForwardScreen";
import SelectContactScreen from "./src/screens/SelectContactScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import AccountScreen from "./src/screens/AccountScreen";
import AddContactMethodScreen from "./src/screens/AddContactMethodScreen";
import AppearanceScreen from "./src/screens/AppearanceScreen";
import LinkedDevicesScreen from "./src/screens/LinkedDevicesScreen";
import BlockedUsersScreen from "./src/screens/BlockedUsersScreen";
import EditProfileScreen from "./src/screens/EditProfileScreen";
import EmailEntryScreen from "./src/screens/EmailEntryScreen";
import OtpScreen from "./src/screens/OtpScreen";
import NameEntryScreen from "./src/screens/NameEntryScreen";
import ProfilePhotoScreen from "./src/screens/ProfilePhotoScreen";
import IncomingCallScreen from "./src/screens/IncomingCallScreen";
import ActiveCallScreen from "./src/screens/ActiveCallScreen";
import FloatingCallWidget from "./src/components/FloatingCallWidget";
import HeaderAddButton from "./src/components/HeaderAddButton";
import TabBarAvatar from "./src/components/TabBarAvatar";
import Logo from "./src/components/Logo";
import { AuthProvider, useAuth } from "./src/auth/AuthContext";
import { MessagingProvider } from "./src/messaging/MessagingContext";
import { PresenceProvider } from "./src/presence/PresenceContext";
import { CallProvider } from "./src/calls/CallContext";
import { flushPendingNavigation, navigationRef } from "./src/navigation/navigationRef";
import { ThemeProvider, useTheme } from "./src/ThemeContext";

export type AuthStackParamList = {
  EmailEntry: undefined;
  Otp: { method: "email" | "phone"; identifier: string };
};

export type ProfileStackParamList = {
  NameEntry: undefined;
  ProfilePhoto: { fullName: string };
};

export type MainTabParamList = {
  Chats: undefined;
  CallHistory: undefined;
  Settings: undefined;
};

export type MainStackParamList = {
  MainTabs: undefined;
  Chat: {
    conversationId: string;
    openSearch?: boolean;
    // Set by ForwardScreen when the user confirms — see ChatScreen's
    // route.params.forwardTargets effect, which sends messageIds to each of
    // these conversations then clears both params.
    forwardTargets?: string[];
    forwardMessageIds?: string[];
    // Set by SelectContactScreen when the user picks a contact — see
    // ChatScreen's route.params.shareContact effect, which sends it as a
    // contact-card message then clears this param.
    shareContact?: { userId: string; name: string; avatarUrl: string | null };
  };
  Forward: { messageIds: string[]; sourceConversationId: string };
  SelectContact: { conversationId: string };
  ArchivedChats: undefined;
  Contacts: undefined;
  ContactInfo: { conversationId: string };
  SharedMedia: { conversationId: string; initialTab?: "media" | "links" | "docs" };
  Account: undefined;
  AddContactMethod: { method: "email" | "phone" };
  Appearance: undefined;
  LinkedDevices: undefined;
  BlockedUsers: undefined;
  EditProfile: undefined;
  IncomingCall: undefined;
  ActiveCall: undefined;
};

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const ProfileStack = createNativeStackNavigator<ProfileStackParamList>();
const MainStack = createNativeStackNavigator<MainStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

function MainTabs() {
  const { colors } = useTheme();

  return (
    <Tab.Navigator
      screenOptions={{
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.tabInactive,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: StyleSheet.hairlineWidth,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "500" },
      }}
    >
      <Tab.Screen
        name="Chats"
        component={ConversationListScreen}
        options={{
          title: "Beacon Chat",
          tabBarLabel: "Chats",
          headerRight: () => <HeaderAddButton />,
          tabBarIcon: ({ focused, color, size }) => (
            <Ionicons name={focused ? "chatbubbles" : "chatbubbles-outline"} size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="CallHistory"
        component={CallHistoryScreen}
        options={{
          title: "Call History",
          tabBarLabel: "Calls",
          tabBarIcon: ({ focused, color, size }) => (
            <Ionicons name={focused ? "call" : "call-outline"} size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          title: "Settings",
          tabBarLabel: "Settings",
          tabBarIcon: ({ focused, color, size }) => <TabBarAvatar focused={focused} color={color} size={size} />,
        }}
      />
    </Tab.Navigator>
  );
}

function RootNavigator() {
  const { status } = useAuth();
  const { colors } = useTheme();

  if (status === "loading") {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: 20,
          backgroundColor: colors.background,
        }}
      >
        <Logo size={72} />
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (status === "signed-out") {
    return (
      <AuthStack.Navigator screenOptions={{ headerShown: false }}>
        <AuthStack.Screen name="EmailEntry" component={EmailEntryScreen} />
        <AuthStack.Screen name="Otp" component={OtpScreen} />
      </AuthStack.Navigator>
    );
  }

  if (status === "needs-profile") {
    return (
      <ProfileStack.Navigator screenOptions={{ headerShown: false }}>
        <ProfileStack.Screen name="NameEntry" component={NameEntryScreen} />
        <ProfileStack.Screen name="ProfilePhoto" component={ProfilePhotoScreen} />
      </ProfileStack.Navigator>
    );
  }

  return (
    <MainStack.Navigator
      initialRouteName="MainTabs"
      screenOptions={{ headerBackButtonDisplayMode: "minimal" }}
    >
      <MainStack.Screen name="MainTabs" component={MainTabs} options={{ headerShown: false }} />
      <MainStack.Screen name="Chat" component={ChatScreen} />
      <MainStack.Screen name="Forward" component={ForwardScreen} options={{ title: "Forward message" }} />
      <MainStack.Screen name="SelectContact" component={SelectContactScreen} options={{ title: "Share Contact" }} />
      <MainStack.Screen name="ArchivedChats" component={ArchivedChatsScreen} options={{ title: "Archived Chats" }} />
      <MainStack.Screen name="Contacts" component={ContactsScreen} options={{ title: "Add People" }} />
      <MainStack.Screen
        name="ContactInfo"
        component={ContactInfoScreen}
        options={{ title: "Contact Info" }}
      />
      <MainStack.Screen
        name="SharedMedia"
        component={SharedMediaScreen}
        options={{ title: "Media, links and docs" }}
      />
      <MainStack.Screen name="Account" component={AccountScreen} options={{ title: "Account" }} />
      <MainStack.Screen
        name="AddContactMethod"
        component={AddContactMethodScreen}
        options={({ route }) => ({ title: route.params.method === "email" ? "Add email" : "Add mobile number" })}
      />
      <MainStack.Screen
        name="Appearance"
        component={AppearanceScreen}
        options={{ title: "Appearance" }}
      />
      <MainStack.Screen
        name="LinkedDevices"
        component={LinkedDevicesScreen}
        options={{ title: "Linked Devices" }}
      />
      <MainStack.Screen
        name="BlockedUsers"
        component={BlockedUsersScreen}
        options={{ title: "Blocked Users" }}
      />
      <MainStack.Screen
        name="EditProfile"
        component={EditProfileScreen}
        options={{ title: "Edit profile" }}
      />
      <MainStack.Screen
        name="IncomingCall"
        component={IncomingCallScreen}
        options={{ headerShown: false, presentation: "fullScreenModal", gestureEnabled: false }}
      />
      <MainStack.Screen
        name="ActiveCall"
        component={ActiveCallScreen}
        options={{ headerShown: false, presentation: "fullScreenModal", gestureEnabled: false }}
      />
    </MainStack.Navigator>
  );
}

function ThemedNavigationContainer() {
  const { scheme } = useTheme();

  return (
    <NavigationContainer
      ref={navigationRef}
      onReady={flushPendingNavigation}
      theme={scheme === "dark" ? NavDarkTheme : NavDefaultTheme}
    >
      <RootNavigator />
      <FloatingCallWidget />
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <MessagingProvider>
            <PresenceProvider>
              <CallProvider>
                <ThemedNavigationContainer />
              </CallProvider>
            </PresenceProvider>
          </MessagingProvider>
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
