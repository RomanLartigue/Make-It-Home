import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SERVER_URL } from '@/constants/config';

export const BACKGROUND_LOCATION_TASK = 'makeithome-background-location';

const ACTIVE_SESSION_KEY = '@makeithome_active_session';
const DEVICE_TOKEN_KEY = '@makeithome_device_token';

TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }: TaskManager.TaskManagerTaskBody<{ locations: Location.LocationObject[] }>) => {
  if (error) {
    console.error('[BG Location]', error.message);
    return;
  }

  const locations = (data as any)?.locations as Location.LocationObject[] | undefined;
  if (!locations?.length) return;

  const { latitude, longitude } = locations[locations.length - 1].coords;

  const [sessionId, deviceToken] = await Promise.all([
    AsyncStorage.getItem(ACTIVE_SESSION_KEY),
    AsyncStorage.getItem(DEVICE_TOKEN_KEY),
  ]);
  if (!sessionId) return;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (deviceToken) headers['X-MIH-Key'] = deviceToken;

  await fetch(`${SERVER_URL}/session/update`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionId, latitude, longitude }),
  }).catch(() => {});
});
