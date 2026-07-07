import { ActivityIndicator, View } from "react-native";
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
import ContactInfoScreen from "./src/screens/ContactInfoScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import EditProfileScreen from "./src/screens/EditProfileScreen";
import EmailEntryScreen from "./src/screens/EmailEntryScreen";
import OtpScreen from "./src/screens/OtpScreen";
import NameEntryScreen from "./src/screens/NameEntryScreen";
import ProfilePhotoScreen from "./src/screens/ProfilePhotoScreen";
import IncomingCallScreen from "./src/screens/IncomingCallScreen";
import ActiveCallScreen from "./src/screens/ActiveCallScreen";
import HeaderAvatarButton from "./src/components/HeaderAvatarButton";
import HeaderAddButton from "./src/components/HeaderAddButton";
import { AuthProvider, useAuth } from "./src/auth/AuthContext";
import { MessagingProvider } from "./src/messaging/MessagingContext";
import { PresenceProvider } from "./src/presence/PresenceContext";
import { CallProvider } from "./src/calls/CallContext";
import { navigationRef } from "./src/navigation/navigationRef";
import { ThemeProvider, useTheme } from "./src/ThemeContext";

export type AuthStackParamList = {
  EmailEntry: undefined;
  Otp: { email: string };
};

export type ProfileStackParamList = {
  NameEntry: undefined;
  ProfilePhoto: { fullName: string };
};

export type MainTabParamList = {
  Chats: undefined;
  CallHistory: undefined;
};

export type MainStackParamList = {
  MainTabs: undefined;
  Chat: { conversationId: string };
  Contacts: undefined;
  ContactInfo: { conversationId: string };
  Settings: undefined;
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
        headerLeft: () => <HeaderAvatarButton />,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.tabInactive,
      }}
    >
      <Tab.Screen
        name="Chats"
        component={ConversationListScreen}
        options={{
          title: "Beacon Chat",
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
          tabBarIcon: ({ focused, color, size }) => (
            <Ionicons name={focused ? "call" : "call-outline"} size={size} color={color} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}

function RootNavigator() {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (status === "signed-out") {
    return (
      <AuthStack.Navigator>
        <AuthStack.Screen
          name="EmailEntry"
          component={EmailEntryScreen}
          options={{ title: "Sign in" }}
        />
        <AuthStack.Screen name="Otp" component={OtpScreen} options={{ title: "Verify code" }} />
      </AuthStack.Navigator>
    );
  }

  if (status === "needs-profile") {
    return (
      <ProfileStack.Navigator>
        <ProfileStack.Screen
          name="NameEntry"
          component={NameEntryScreen}
          options={{ title: "Your name" }}
        />
        <ProfileStack.Screen
          name="ProfilePhoto"
          component={ProfilePhotoScreen}
          options={{ title: "Your photo" }}
        />
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
      <MainStack.Screen name="Contacts" component={ContactsScreen} options={{ title: "Add People" }} />
      <MainStack.Screen
        name="ContactInfo"
        component={ContactInfoScreen}
        options={{ title: "Contact Info" }}
      />
      <MainStack.Screen name="Settings" component={SettingsScreen} options={{ title: "Settings" }} />
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
    <NavigationContainer ref={navigationRef} theme={scheme === "dark" ? NavDarkTheme : NavDefaultTheme}>
      <RootNavigator />
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
