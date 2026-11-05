import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Redirect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

export default function Index() {
  const [target, setTarget] = useState<'/(tabs)' | '/onboarding' | null>(null);

  useEffect(() => {
    AsyncStorage.getItem('@makeithome_onboarded')
      .then(done => {
        setTarget(done === 'true' ? '/(tabs)' : '/onboarding');
      })
      // A failed storage read must not strand the app on the blank holding
      // screen forever — worst case the user sees onboarding again.
      .catch(() => setTarget('/onboarding'));
  }, []);

  // Hold a blank screen while we check — avoids any flash
  if (!target) return <View style={{ flex: 1, backgroundColor: '#0b1119' }} />;
  return <Redirect href={target} />;
}
