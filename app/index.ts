import { registerRootComponent } from 'expo';
import notifee from '@notifee/react-native';

import App from './App';

// Notifee requires a background handler to be registered unconditionally at
// the JS entry point (not inside a component) — taps/actions on a
// notification while the app is backgrounded but not killed are delivered
// here. Actually opening the tapped conversation happens once the app is
// foregrounded, via notificationService's onForegroundEvent listener (see
// MessagingContext) — this handler only needs to exist so Android doesn't
// drop those background-delivered events before the app comes back up.
notifee.onBackgroundEvent(async () => {});

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
