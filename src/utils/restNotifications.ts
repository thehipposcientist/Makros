import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { loadSettings } from './feedback';

type RestNotificationIds = {
  startId?: string;
  warningId?: string;
  completeId?: string;
};

const REST_TIMER_CHANNEL_ID = 'rest-timer';
const REST_TIMER_SILENT_CHANNEL_ID = 'rest-timer-silent';

let configured = false;
let permissionsRequested = false;

export async function configureWorkoutNotifications() {
  if (configured) return;

  Notifications.setNotificationHandler({
    // Foreground rest completion uses feedback.ts::playRestTimerDone so
    // the user-selected in-app sound plays once. Background/killed
    // delivery bypasses this handler and uses the notification sound.
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(REST_TIMER_CHANNEL_ID, {
      name: 'Rest Timer',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 120, 250],
      sound: 'default',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
    await Notifications.setNotificationChannelAsync(REST_TIMER_SILENT_CHANNEL_ID, {
      name: 'Rest Timer Silent',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250],
      sound: null,
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

  // The completion notification is audible only when the app is not
  // foregrounded. Foreground delivery is muted by the handler above so it
  // cannot double with the in-app chime.
  const settings = await loadSettings();
  const playCompletionSound = settings.soundsEnabled;
  const completeChannelId = playCompletionSound ? REST_TIMER_CHANNEL_ID : REST_TIMER_SILENT_CHANNEL_ID;
  const aiLine = params.aiCue ? `\n${params.aiCue}` : '';
  const endTime = new Date(Date.now() + params.seconds * 1000);
  const endClock = endTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  let startId: string | undefined;
  if (params.includeStartAlert !== false) {
    startId = await Notifications.scheduleNotificationAsync({
      content: {
        title: `Rest — ${params.seconds}s  ·  ends ${endClock}`,
        body: `${params.exerciseName}\n${params.nextSetLabel}${aiLine}`,
        // Starting a rest timer happens immediately after logging a set.
        // Keep that notification silent so it cannot interrupt music.
        ...(Platform.OS === 'android' ? { sticky: false, ongoing: false } : {}),
      },
      trigger: Platform.OS === 'android' ? { channelId: REST_TIMER_SILENT_CHANNEL_ID } : null,
    });
  }

  let warningId: string | undefined;
  if (params.seconds > 10) {
    warningId = await Notifications.scheduleNotificationAsync({
      content: {
        title: '10 seconds left — get ready',
        body: `${params.exerciseName}\n${params.nextSetLabel}`,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: params.seconds - 10,
        ...(Platform.OS === 'android' ? { channelId: REST_TIMER_SILENT_CHANNEL_ID } : {}),
      },
    });
  }

  const completeId = await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Go! Next set ready',
      body: `${params.exerciseName}\n${params.nextSetLabel}${aiLine}`,
      // Native background/killed alert sound. Foreground handler suppresses
      // this so feedback.ts can play the selected in-app sound once.
      sound: playCompletionSound ? 'default' : false,
      // timeSensitive bypasses Workout/DND Focus modes on both iPhone and
      // the mirrored Watch notification — without it the ding is silenced
      // whenever the Watch auto-activates Workout Focus.
      ...(Platform.OS === 'ios' ? { interruptionLevel: 'timeSensitive' as const } : {}),
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: params.seconds,
      ...(Platform.OS === 'android' ? { channelId: completeChannelId } : {}),
    },
  });

  return { startId, warningId, completeId };
}
