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
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
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

  const aiLine = params.aiCue ? ` Cue: ${params.aiCue}` : '';
  let startId: string | undefined;
  if (params.includeStartAlert !== false) {
    startId = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Rest timer started',
        body: `${params.seconds}s for ${params.exerciseName}. ${params.nextSetLabel}.${aiLine}`,
        sound: 'default',
      },
      trigger: null,
    });
  }

  let warningId: string | undefined;
  if (params.seconds > 10) {
    warningId = await Notifications.scheduleNotificationAsync({
      content: {
        title: '10 seconds left',
        body: `${params.exerciseName} is almost up. ${params.nextSetLabel}.`,
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
      title: 'Next set ready',
      body: `${params.exerciseName}. ${params.nextSetLabel}.${aiLine}`,
      sound: 'default',
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: params.seconds,
    },
  });

  return { startId, warningId, completeId };
}