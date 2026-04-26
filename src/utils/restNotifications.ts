import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

type RestNotificationIds = {
  startId?: string;
  warningId?: string;
  completeId?: string;
};

let configured = false;
let permissionsRequested = false;

export async function configureWorkoutNotifications() {
  if (configured) return;

  Notifications.setNotificationHandler({
    // shouldPlaySound: false avoids doubling up with the in-app chime
    // (feedback.ts::playRestTimerDone) when the app is foregrounded.
    // Background notifications still play their sound natively because
    // iOS handles the system sound outside this handler. Net effect:
    // one brief sound per rest-end regardless of app state.
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('rest-timer', {
      name: 'Rest Timer',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 120, 250],
      sound: 'default',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }

  configured = true;
}

export async function ensureWorkoutNotificationPermission() {
  if (permissionsRequested) return true;

  await configureWorkoutNotifications();
  const current = await Notifications.getPermissionsAsync();
  if (current.granted || current.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) {
    permissionsRequested = true;
    return true;
  }

  const next = await Notifications.requestPermissionsAsync();
  permissionsRequested = !!next.granted;
  return !!next.granted;
}

export async function cancelRestNotifications(ids?: RestNotificationIds | null) {
  const allIds = [ids?.startId, ids?.warningId, ids?.completeId].filter(Boolean) as string[];
  await Promise.all(allIds.map((id) => Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined)));
}

export async function scheduleRestNotifications(params: {
  seconds: number;
  exerciseName: string;
  nextSetLabel: string;
  aiCue?: string | null;
  includeStartAlert?: boolean;
}): Promise<RestNotificationIds> {
  const granted = await ensureWorkoutNotificationPermission();
  if (!granted) return {};

  const aiLine = params.aiCue ? `\n${params.aiCue}` : '';
  const endTime = new Date(Date.now() + params.seconds * 1000);
  const endClock = endTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  let startId: string | undefined;
  if (params.includeStartAlert !== false) {
    startId = await Notifications.scheduleNotificationAsync({
      content: {
        title: `Rest — ${params.seconds}s  ·  ends ${endClock}`,
        body: `${params.exerciseName}\n${params.nextSetLabel}${aiLine}`,
        sound: 'default',
        ...(Platform.OS === 'android' ? { sticky: false, ongoing: false } : {}),
      },
      trigger: null,
    });
  }

  let warningId: string | undefined;
  if (params.seconds > 10) {
    warningId = await Notifications.scheduleNotificationAsync({
      content: {
        title: '10 seconds left — get ready',
        body: `${params.exerciseName}\n${params.nextSetLabel}`,
        sound: 'default',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: params.seconds - 10,
      },
    });
  }

  const completeId = await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Go! Next set ready',
      body: `${params.exerciseName}\n${params.nextSetLabel}${aiLine}`,
      sound: 'default',
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: params.seconds,
    },
  });

  return { startId, warningId, completeId };
}