import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { RootStackParamList, UserProfile } from '../types';
import OnboardingScreen from '../screens/OnboardingScreen';
import HomeScreen from '../screens/HomeScreen';

export type { RootStackParamList };

const Stack = createStackNavigator<RootStackParamList>();

interface NavigationProps {
  userProfile: UserProfile | null;
  onProfileUpdate: (profile: UserProfile) => void;
}

export function RootNavigator(props: NavigationProps) {
  // Show Onboarding if no profile, otherwise show Home
  const isFirstTime = !props.userProfile;

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerShown: true,
          headerStyle: {
            backgroundColor: '#ffffff',
            borderBottomWidth: 1,
            borderBottomColor: '#e0e0e0',
          },
          headerTitleStyle: {
            fontSize: 18,
            fontWeight: '600',
          },
          headerTintColor: '#000',
        }}
      >
        {isFirstTime ? (
          <Stack.Screen
            name="Onboarding"
            options={{
              headerShown: false,
              animationEnabled: false,
            }}
          >
            {() => <OnboardingScreen onComplete={props.onProfileUpdate} />}
          </Stack.Screen>
        ) : (
          <Stack.Screen
            name="Home"
            options={{
              title: 'WorkoutPal',
              headerLeft: () => null,
              animationEnabled: false,
            }}
          >
            {() => <HomeScreen userProfile={props.userProfile} />}
          </Stack.Screen>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default RootNavigator;
