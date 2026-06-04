import { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, ActivityIndicator, KeyboardAvoidingView,
  Platform, Image, ImageBackground, Dimensions, Alert, Animated, Easing, useWindowDimensions,
} from 'react-native';
import Constants from 'expo-constants';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { login, register, resetPassword, getRecoveryQuestion, setRecoveryQuestion, loginWithApple, loginWithGoogle } from '../services/api';
import { colors, radius } from '../constants/theme';
import FadeInView from '../components/FadeInView';
import LegalDisclosureModal from '../components/LegalDisclosureModal';
import BrandMark from '../components/BrandMark';
import { LEGAL_VERSION, legalAcceptanceLabel } from '../constants/legal';
import { isFeatureEnabled } from '../utils/featureFlags';
import { SIGNUP_TRIAL_DAYS } from '../utils/subscription';
import { pexelsPhoto } from '../constants/stockImages';

const { width: SCREEN_W } = Dimensions.get('window');
const logo = require('../../assets/images/thallo-logo-white-transparent-New.png');
const compactLogo = require('../../assets/images/thallo-logo-compact-white.png');

const SIGNUP_FEATURE_PREVIEW: Array<{
  key: string;
  title: string;
  body: string;
  image: string;
  icon: keyof typeof Ionicons.glyphMap;
  accent: string;
}> = [
  {
    key: 'plan',
    title: 'Plan your week',
    body: 'Goal, schedule, gear, and recovery shape a stable 7-day plan.',
    image: pexelsPhoto('5878699', { width: 520, height: 380 }),
    icon: 'calendar-outline',
    accent: '#15C7B8',
  },
  {
    key: 'meals',
    title: 'Track food faster',
    body: 'Log meals, hydration, routines, supplements, and scans.',
    image: pexelsPhoto('30635713', { width: 520, height: 380 }),
    icon: 'restaurant-outline',
    accent: '#7CFCB2',
  },
  {
    key: 'signals',
    title: 'Connect signals',
    body: 'Use progress, readiness, body trends, and health data together.',
    image: pexelsPhoto('32977239', { width: 520, height: 380 }),
    icon: 'pulse-outline',
    accent: '#40CCE8',
  },
];

const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
const GOOGLE_CLIENT_ID_RE = /^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/;
const GOOGLE_CLIENT_ID_PLACEHOLDER = 'missing-google-client-id.apps.googleusercontent.com';

WebBrowser.maybeCompleteAuthSession();

function configured(value?: string | null): string | undefined {
  const cleaned = (value ?? '').trim();
  if (!GOOGLE_CLIENT_ID_RE.test(cleaned)) return undefined;
  return cleaned;
}

function googleOAuthConfig() {
  const extra = (Constants.expoConfig?.extra ?? {}) as {
    googleWebClientId?: string;
    googleIosClientId?: string;
    googleAndroidClientId?: string;
  };
  const webClientId = configured(process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID) ?? configured(extra.googleWebClientId);
  const iosClientId = configured(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID) ?? configured(extra.googleIosClientId);
  const androidClientId = configured(process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID) ?? configured(extra.googleAndroidClientId);
  return { webClientId, iosClientId, androidClientId };
}

const GOOGLE_OAUTH = googleOAuthConfig();

interface AuthScreenProps {
  onAuthenticated: (token: string, isNewUser: boolean) => void;
  initialMode?: 'login' | 'signup';
  onBack?: () => void;
}

export default function AuthScreen({ onAuthenticated, initialMode = 'login', onBack }: AuthScreenProps) {
  // Reset flow is two-step: 'reset_email' (enter email + fetch question) → 'reset_answer' (answer + new password)
  const [mode, setMode] = useState<'login' | 'signup' | 'reset_email' | 'reset_answer'>(initialMode);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [recoveryQuestion, setRecoveryQuestionText] = useState('');
  const [recoveryAnswer, setRecoveryAnswer] = useState('');
  // Signup-only: user picks from a preset list for ease of recall.
  const [signupRecoveryQuestion, setSignupRecoveryQuestion] = useState<string>(
    "What was the name of your first pet?"
  );
  const [signupRecoveryAnswer, setSignupRecoveryAnswer] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [acceptedLegal, setAcceptedLegal] = useState(false);
  const [showLegal, setShowLegal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [appleAvailable, setAppleAvailable] = useState(false);
  const gradientAnim = useRef(new Animated.Value(0)).current;
  const gradientDriftAnim = useRef(new Animated.Value(0)).current;
  const gradientPulseAnim = useRef(new Animated.Value(0)).current;

  const emailTouched = email.length > 0;
  const emailValid = EMAIL_RE.test(email.trim());
  const signupDisabled = mode === 'signup' && emailTouched && !emailValid;
  const maestroTestAccount = __DEV__ && email.trim().endsWith('@test.thallo');
  const showSocialSignIn = mode === 'login' || mode === 'signup';
  const showAppleSignIn = Platform.OS === 'ios' && showSocialSignIn;
  const activeGoogleClientId = Platform.select({
    ios: GOOGLE_OAUTH.iosClientId,
    android: GOOGLE_OAUTH.androidClientId,
    default: GOOGLE_OAUTH.webClientId,
  });
  const googleConfigured = !!activeGoogleClientId;
  const showGoogleSignIn = showSocialSignIn && googleConfigured;
  const showSocialProviders = showGoogleSignIn || showAppleSignIn;
  const billingBetaEnabled = isFeatureEnabled('billing.revenueCat');
  const socialLegalProviders = showGoogleSignIn && showAppleSignIn
    ? 'Google or Apple'
    : showAppleSignIn
      ? 'Apple'
      : 'Google';
  const googleClientId = activeGoogleClientId ?? GOOGLE_CLIENT_ID_PLACEHOLDER;
  const { width: viewportWidth } = useWindowDimensions();
  const webMode = Platform.OS === 'web';
  const webCompact = webMode && viewportWidth < 900;
  const [googleRequest, googleResponse, promptGoogleAsync] = Google.useIdTokenAuthRequest({
    clientId: googleClientId,
    webClientId: GOOGLE_OAUTH.webClientId ?? GOOGLE_CLIENT_ID_PLACEHOLDER,
    iosClientId: GOOGLE_OAUTH.iosClientId ?? GOOGLE_CLIENT_ID_PLACEHOLDER,
    androidClientId: GOOGLE_OAUTH.androidClientId ?? GOOGLE_CLIENT_ID_PLACEHOLDER,
    selectAccount: true,
  });

  const firstNameRef       = useRef<TextInput>(null);
  const lastNameRef        = useRef<TextInput>(null);
  const emailRef           = useRef<TextInput>(null);
  const usernameRef        = useRef<TextInput>(null);
  const passwordRef        = useRef<TextInput>(null);
  const confirmPasswordRef = useRef<TextInput>(null);
  const answerRef          = useRef<TextInput>(null);
  const scrollRef          = useRef<ScrollView>(null);
  const handledGoogleTokenRef = useRef<string | null>(null);
  const gradientShiftX = gradientAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [-SCREEN_W * 0.34, SCREEN_W * 0.22, -SCREEN_W * 0.34],
  });
  const gradientShiftY = gradientAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [-68, 48, -68],
  });
  const gradientPrimaryScale = gradientAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [1.02, 1.18, 1.02],
  });
  const gradientPrimaryRotate = gradientAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: ['-14deg', '7deg', '-14deg'],
  });
  const gradientReverseShiftX = gradientAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [SCREEN_W * 0.2, -SCREEN_W * 0.18, SCREEN_W * 0.2],
  });
  const gradientReverseShiftY = gradientAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [52, -46, 52],
  });
  const gradientReverseScale = gradientAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [1.16, 1.02, 1.16],
  });
  const gradientAccentOpacity = gradientAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.14, 0.42, 0.14],
  });
  const gradientHighlightOpacity = gradientAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.34, 0.14, 0.34],
  });
  const gradientRibbonShiftX = gradientDriftAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [SCREEN_W * 0.24, -SCREEN_W * 0.28, SCREEN_W * 0.24],
  });
  const gradientRibbonShiftY = gradientDriftAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [-36, 72, -36],
  });
  const gradientRibbonRotate = gradientDriftAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: ['18deg', '-9deg', '18deg'],
  });
  const gradientRibbonOpacity = gradientDriftAnim.interpolate({
    inputRange: [0, 0.48, 1],
    outputRange: [0.12, 0.3, 0.12],
  });
  const gradientFloorScale = gradientPulseAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [1.04, 1.2, 1.04],
  });
  const gradientFloorShiftX = gradientPulseAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [-SCREEN_W * 0.12, SCREEN_W * 0.16, -SCREEN_W * 0.12],
  });
  const gradientFloorOpacity = gradientPulseAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.16, 0.36, 0.16],
  });

  useEffect(() => {
    const loops = [
      Animated.loop(
        Animated.timing(gradientAnim, {
          toValue: 1,
          duration: 11800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ),
      Animated.loop(
        Animated.timing(gradientDriftAnim, {
          toValue: 1,
          duration: 16400,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
      ),
      Animated.loop(
        Animated.timing(gradientPulseAnim, {
          toValue: 1,
          duration: 9400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ),
    ];
    loops.forEach(loop => loop.start());
    return () => loops.forEach(loop => loop.stop());
  }, [gradientAnim, gradientDriftAnim, gradientPulseAnim]);

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      document.title = mode === 'signup' ? 'Thallo - Create account' : 'Thallo - Sign in';
    }
  }, [mode]);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let mounted = true;
    AppleAuthentication.isAvailableAsync()
      .then(v => { if (mounted) setAppleAvailable(v); })
      .catch(() => { if (mounted) setAppleAvailable(false); });
    return () => { mounted = false; };
  }, []);

  const switchMode = (next: 'login' | 'signup' | 'reset_email' | 'reset_answer') => {
    setMode(next);
    setError('');
    setPassword('');
    setConfirmPassword('');
    setRecoveryAnswer('');
    if (next !== 'reset_answer') setRecoveryQuestionText('');
    setShowPassword(false);
    setShowConfirmPassword(false);
  };

  const showProviderError = (title: string, message: string) => {
    setError(message);
    Alert.alert(title, message);
  };

  const canContinueWithProvider = (provider: 'Apple' | 'Google'): boolean => {
    if (mode !== 'signup' || acceptedLegal) return true;
    const message = `Please accept the Terms, Privacy Policy, Health Disclaimer, and AI Disclosure before creating an account with ${provider}.`;
    setError(message);
    Alert.alert('Legal acceptance required', message);
    return false;
  };

  useEffect(() => {
    if (!googleResponse) return;
    if (googleResponse.type === 'success') {
      const identityToken = googleResponse.params.id_token || googleResponse.authentication?.idToken;
      if (!identityToken) {
        setLoading(false);
        showProviderError('Google sign-in failed', 'Google did not return an identity token.');
        return;
      }
      if (handledGoogleTokenRef.current === identityToken) return;
      handledGoogleTokenRef.current = identityToken;
      (async () => {
        try {
          const { access_token, is_new_user } = await loginWithGoogle(identityToken, {
            legalVersion: LEGAL_VERSION,
            acceptedTerms: mode === 'signup' && acceptedLegal,
            acceptedPrivacy: mode === 'signup' && acceptedLegal,
            acceptedHealthDisclaimer: mode === 'signup' && acceptedLegal,
            acceptedAiDisclaimer: mode === 'signup' && acceptedLegal,
          });
          onAuthenticated(access_token, is_new_user);
        } catch (e: any) {
          showProviderError('Google sign-in failed', e?.message ?? 'Unable to continue with Google');
        } finally {
          setLoading(false);
        }
      })();
      return;
    }
    if (googleResponse.type === 'error') {
      setLoading(false);
      showProviderError(
        'Google sign-in failed',
        googleResponse.error?.message ?? googleResponse.params?.error_description ?? 'Unable to continue with Google',
      );
    }
  }, [googleResponse, mode, acceptedLegal]);

  const handleGoogleSignIn = async () => {
    if (loading) return;
    if (!canContinueWithProvider('Google')) return;
    if (!googleConfigured) {
      showProviderError(
        'Google sign-in unavailable',
        'Google OAuth client IDs are missing for this build.',
      );
      return;
    }
    if (!googleRequest) {
      showProviderError('Google sign-in loading', 'Google sign-in is still getting ready. Try again in a moment.');
      return;
    }
    setError('');
    setLoading(true);
    handledGoogleTokenRef.current = null;
    try {
      const result = await promptGoogleAsync();
      if (result.type === 'cancel' || result.type === 'dismiss' || result.type === 'locked') {
        setLoading(false);
      }
    } catch (e: any) {
      setLoading(false);
      showProviderError('Google sign-in failed', e?.message ?? 'Unable to continue with Google');
    }
  };

  const handleAppleSignIn = async () => {
    if (loading) return;
    if (!canContinueWithProvider('Apple')) return;
    setError('');
    setLoading(true);
    try {
      const available = appleAvailable || await AppleAuthentication.isAvailableAsync().catch(() => false);
      if (!available) {
        throw new Error('Apple sign-in is not available on this device.');
      }
      if (!appleAvailable) setAppleAvailable(true);
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!credential.identityToken) {
        throw new Error('Apple did not return an identity token');
      }
      const { access_token, is_new_user } = await loginWithApple(credential.identityToken, {
        firstName: credential.fullName?.givenName ?? undefined,
        lastName: credential.fullName?.familyName ?? undefined,
        legalVersion: LEGAL_VERSION,
        acceptedTerms: mode === 'signup' && acceptedLegal,
        acceptedPrivacy: mode === 'signup' && acceptedLegal,
        acceptedHealthDisclaimer: mode === 'signup' && acceptedLegal,
        acceptedAiDisclaimer: mode === 'signup' && acceptedLegal,
      });
      onAuthenticated(access_token, is_new_user);
    } catch (e: any) {
      if (e?.code !== 'ERR_REQUEST_CANCELED') {
        showProviderError('Apple sign-in failed', e?.message ?? 'Unable to continue with Apple');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    setError('');
    // Reset step 1: look up question
    if (mode === 'reset_email') {
      if (!email.trim()) { setError('Enter your email'); return; }
      setLoading(true);
      try {
        const { question } = await getRecoveryQuestion(email.trim());
        setRecoveryQuestionText(question);
        setMode('reset_answer');
      } catch (e: any) {
        // Surface the backend's generic message — matches failed-answer case.
        setError(e?.message ?? 'No recovery question available for that email');
      } finally {
        setLoading(false);
      }
      return;
    }

    // Reset step 2: submit answer + new password
    if (mode === 'reset_answer') {
      if (!recoveryAnswer.trim()) { setError('Enter your answer'); return; }
      if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
      if (!/\d/.test(password)) { setError('Password must include at least one number'); return; }
      if (password !== confirmPassword) { setError('Passwords do not match'); return; }
      setLoading(true);
      try {
        const { access_token } = await resetPassword(email.trim(), recoveryAnswer.trim(), password);
        onAuthenticated(access_token, false);
      } catch (e: any) {
        setError(e?.message ?? 'Unable to reset password');
      } finally {
        setLoading(false);
      }
      return;
    }

    // Login / signup
    if (!email.trim() || !password.trim()) {
      setError('Email and password are required');
      return;
    }
    if (mode === 'signup') {
      if (!EMAIL_RE.test(email.trim())) { setError('Enter a valid email address'); return; }
      if (!firstName.trim()) { setError('First name is required'); return; }
      if (!lastName.trim()) { setError('Last name is required'); return; }
      if (!username.trim()) { setError('Username is required'); return; }
      if (!USERNAME_RE.test(username.trim().toLowerCase())) { setError('Username must be 3-32 characters and use only letters, numbers, or underscores'); return; }
      if (password !== confirmPassword) { setError('Passwords do not match'); return; }
      if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
      if (!/\d/.test(password)) { setError('Password must include at least one number'); return; }
      if (!acceptedLegal) { setError('Please accept the Terms, Privacy Policy, Health Disclaimer, and AI Disclosure'); return; }
      if (!signupRecoveryAnswer.trim() || signupRecoveryAnswer.trim().length < 2) {
        setError("Please answer your security question — you'll need it to reset your password");
        return;
      }
    }
    setLoading(true);
    try {
      const isNewUser = mode === 'signup';
      if (isNewUser) {
        await register(email.trim(), username.trim().toLowerCase(), password, {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          acceptedTerms: acceptedLegal,
          acceptedPrivacy: acceptedLegal,
          acceptedHealthDisclaimer: acceptedLegal,
          acceptedAiDisclaimer: acceptedLegal,
          legalVersion: LEGAL_VERSION,
        });
      }
      const { access_token } = await login(email.trim(), password);
      // Set the recovery question/answer right after signup so password
      // reset works without a separate profile trip. Non-blocking — a
      // failure here still lets the user into onboarding, and they can
      // set it later from Profile.
      if (isNewUser) {
        try {
          await setRecoveryQuestion(access_token, signupRecoveryQuestion, signupRecoveryAnswer.trim());
        } catch (e) {
          console.log('[auth] set recovery question failed:', e);
        }
      }
      onAuthenticated(access_token, isNewUser);
    } catch (e: any) {
      setError(e.message ?? 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}>
      <View pointerEvents="none" style={styles.backgroundLayers}>
        <LinearGradient
          colors={['#080B12', '#10201F', '#161322', '#0D0F14']}
          locations={[0, 0.36, 0.72, 1]}
          start={{ x: 0.05, y: 0 }}
          end={{ x: 0.95, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View
          style={[
            styles.gradientWash,
            styles.gradientWashPrimary,
            {
              opacity: gradientAccentOpacity,
              transform: [
                { translateX: gradientShiftX },
                { translateY: gradientShiftY },
                { rotate: gradientPrimaryRotate },
                { scale: gradientPrimaryScale },
              ],
            },
          ]}
        >
          <LinearGradient
            colors={['rgba(21,199,184,0)', 'rgba(21,199,184,0.62)', 'rgba(124,252,178,0.1)']}
            locations={[0, 0.44, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        <Animated.View
          style={[
            styles.gradientWash,
            styles.gradientWashSecondary,
            {
              opacity: gradientHighlightOpacity,
              transform: [
                { translateX: gradientReverseShiftX },
                { translateY: gradientReverseShiftY },
                { rotate: '12deg' },
                { scale: gradientReverseScale },
              ],
            },
          ]}
        >
          <LinearGradient
            colors={['rgba(152,56,248,0)', 'rgba(64,204,232,0.42)', 'rgba(255,104,88,0.1)']}
            locations={[0, 0.52, 1]}
            start={{ x: 1, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        <Animated.View
          style={[
            styles.gradientRibbon,
            {
              opacity: gradientRibbonOpacity,
              transform: [
                { translateX: gradientRibbonShiftX },
                { translateY: gradientRibbonShiftY },
                { rotate: gradientRibbonRotate },
              ],
            },
          ]}
        >
          <LinearGradient
            colors={['rgba(255,104,88,0)', 'rgba(255,180,84,0.4)', 'rgba(21,199,184,0.22)', 'rgba(255,104,88,0)']}
            locations={[0, 0.28, 0.66, 1]}
            start={{ x: 0, y: 0.35 }}
            end={{ x: 1, y: 0.65 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        <Animated.View
          style={[
            styles.gradientFloor,
            {
              opacity: gradientFloorOpacity,
              transform: [
                { translateX: gradientFloorShiftX },
                { scale: gradientFloorScale },
              ],
            },
          ]}
        >
          <LinearGradient
            colors={['rgba(13,148,136,0)', 'rgba(13,148,136,0.34)', 'rgba(104,228,244,0.26)', 'rgba(13,148,136,0)']}
            locations={[0, 0.32, 0.68, 1]}
            start={{ x: 0, y: 1 }}
            end={{ x: 1, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        <LinearGradient
          colors={['rgba(13,15,20,0.08)', 'rgba(13,15,20,0.54)', 'rgba(13,15,20,0.94)']}
          locations={[0, 0.48, 1]}
          style={StyleSheet.absoluteFill}
        />
      </View>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          webMode && styles.webContent,
          webCompact && styles.webContentCompact,
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}>

        <View style={[webMode && styles.webShell, webCompact && styles.webShellCompact]}>
          {webMode && !webCompact ? (
            <View style={styles.webIntroPanel}>
              <Text style={styles.webEyebrow}>Thallo web</Text>
              <Text style={styles.webIntroTitle}>Review the week without opening the phone app.</Text>
              <Text style={styles.webIntroBody}>
                Today, trends, body history, health signals, and coaching insights in a calmer browser layout.
              </Text>
              <View style={styles.webIntroList}>
                {[
                  ['calendar-outline', 'Stable 7-day plan context'],
                  ['bar-chart-outline', 'Workout and body history'],
                  ['pulse-outline', 'Recovery and health signals'],
                ].map(([icon, label]) => (
                  <View key={label} style={styles.webIntroItem}>
                    <View style={styles.webIntroIcon}>
                      <Ionicons name={icon as keyof typeof Ionicons.glyphMap} size={16} color={colors.primary} />
                    </View>
                    <Text style={styles.webIntroItemText}>{label}</Text>
                  </View>
                ))}
              </View>
              {onBack ? (
                <TouchableOpacity activeOpacity={0.76} onPress={onBack} style={styles.webMarketingLink}>
                  <Ionicons name="arrow-back-outline" size={16} color={colors.textSecondary} />
                  <Text style={styles.webMarketingLinkText}>Back to Thallo</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}

          <View style={[webMode && styles.webAuthPane]}>
            {/* Logo */}
            <View style={[
              styles.logoContainer,
              onBack && styles.logoContainerCompact,
              webMode && styles.webLogoContainer,
            ]}>
              {onBack && (
                <TouchableOpacity
                  testID="auth-back-to-landing"
                  activeOpacity={0.75}
                  style={[styles.backButton, webMode && styles.webBackButton]}
                  onPress={onBack}
                >
                  <Ionicons name="chevron-back" size={18} color={colors.textPrimary} />
                  <Text style={styles.backButtonText}>Back</Text>
                </TouchableOpacity>
              )}
              <BrandMark
                size={webMode ? 78 : onBack ? 76 : 96}
                variant="tile"
                animated={!loading}
                style={[styles.authBrandMark, onBack && styles.authBrandMarkCompact]}
              />
              <Image
                source={webMode ? compactLogo : logo}
                style={[styles.logo, onBack && styles.logoCompact, webMode && styles.webLogo]}
                resizeMode="contain"
              />
              {onBack ? (
                <Text style={[styles.authTitle, webMode && styles.webAuthTitle]}>
                  {mode === 'signup' ? 'Create your Thallo account' : 'Welcome back'}
                </Text>
              ) : (
                <>
                  <Text style={styles.tagline}>Total health for training, nutrition, recovery, and coaching.</Text>
                  <View style={styles.featureRow}>
                    {(['Stable weekly plans', 'Nutrition support', 'Health signals'] as const).map(f => (
                      <View key={f} style={styles.featureChip}>
                        <Text style={styles.featureChipText}>{f}</Text>
                      </View>
                    ))}
                  </View>
                  <Text style={styles.subtag}>Set up in under 3 minutes</Text>
                </>
              )}
            </View>

            <View style={[styles.divider, webMode && styles.webDivider]} />

            {/* Auth form */}
            <View style={[styles.formCard, webMode && styles.webFormCard]}>
          {/* Login / Sign Up toggle — sliding pill indicator */}
          <View style={styles.toggle}>
            <TouchableOpacity
              testID="auth-mode-login"
              activeOpacity={0.75}
              style={[styles.toggleButton, mode === 'login' && styles.toggleButtonActive]}
              onPress={() => switchMode('login')}>
              <Text style={[styles.toggleText, mode === 'login' && styles.toggleTextActive]}>Sign In</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="auth-mode-signup"
              activeOpacity={0.75}
              style={[styles.toggleButton, mode === 'signup' && styles.toggleButtonActive]}
              onPress={() => switchMode('signup')}>
              <Text style={[styles.toggleText, mode === 'signup' && styles.toggleTextActive]}>Create Account</Text>
            </TouchableOpacity>
          </View>

          {mode === 'signup' && billingBetaEnabled && (
            <View
              style={styles.trialBanner}
              testID="auth-signup-trial-banner"
              accessibilityLabel="auth-signup-trial-banner"
            >
              <View style={styles.trialIcon}>
                <Ionicons name="sparkles-outline" size={17} color={colors.primary} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.trialTitle}>{SIGNUP_TRIAL_DAYS}-day Pro trial included</Text>
                <Text style={styles.trialText}>
                  Generated plans, coach chat, scans, readiness, and nutrition scoring unlock after account creation. No payment at signup.
                </Text>
              </View>
            </View>
          )}

          {mode === 'signup' && (
            <View style={styles.signupFeaturePanel}>
              <View style={styles.signupFeatureHeader}>
                <View>
                  <Text style={styles.signupFeatureEyebrow}>After signup</Text>
                  <Text style={styles.signupFeatureTitle}>What Thallo can do for you</Text>
                </View>
                <Ionicons name="sparkles-outline" size={18} color={colors.primary} />
              </View>
              <ScrollView
                horizontal
                decelerationRate="fast"
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.signupFeatureScrollerContent}
                style={styles.signupFeatureScroller}
              >
                {SIGNUP_FEATURE_PREVIEW.map((feature) => (
                  <ImageBackground
                    key={feature.key}
                    source={{ uri: feature.image }}
                    resizeMode="cover"
                    imageStyle={styles.signupFeatureImage}
                    style={styles.signupFeatureCard}
                  >
                    <LinearGradient
                      colors={['rgba(5,10,14,0.16)', 'rgba(5,10,14,0.72)']}
                      locations={[0, 1]}
                      style={StyleSheet.absoluteFill}
                    />
                    <View style={[styles.signupFeatureIcon, { backgroundColor: feature.accent + '2E' }]}>
                      <Ionicons name={feature.icon} size={16} color="#FFFFFF" />
                    </View>
                    <View style={styles.signupFeatureCopy}>
                      <Text style={styles.signupFeatureCardTitle} numberOfLines={1}>{feature.title}</Text>
                      <Text style={styles.signupFeatureCardBody} numberOfLines={3}>{feature.body}</Text>
                    </View>
                  </ImageBackground>
                ))}
              </ScrollView>
            </View>
          )}

          {showSocialProviders && (
            <View style={styles.socialBlock}>
              <View style={styles.socialRow}>
                {showGoogleSignIn && (
                  <TouchableOpacity
                    testID="auth-google-button"
                    activeOpacity={0.78}
                    style={[styles.socialProviderButton, loading && styles.socialProviderButtonDisabled]}
                    onPress={handleGoogleSignIn}
                    disabled={loading}
                  >
                    <Ionicons name="logo-google" size={18} color="#4285F4" />
                    <Text
                      style={styles.socialProviderText}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.82}
                    >
                      Google
                    </Text>
                  </TouchableOpacity>
                )}
                {showAppleSignIn && (
                  <TouchableOpacity
                    testID="auth-apple-button"
                    activeOpacity={0.78}
                    style={[styles.socialProviderButton, loading && styles.socialProviderButtonDisabled]}
                    onPress={handleAppleSignIn}
                    disabled={loading}
                  >
                    <Ionicons name="logo-apple" size={20} color="#111827" />
                    <Text
                      style={styles.socialProviderText}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.82}
                    >
                      Apple
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
              <TouchableOpacity onPress={() => setShowLegal(true)} activeOpacity={0.75}>
                <Text style={styles.socialLegalText}>
                  {mode === 'signup'
                    ? `To create an account with ${socialLegalProviders}, review and accept Thallo's Terms, Privacy Policy, Health Disclaimer, and AI Disclosure below.`
                    : `Existing accounts can sign in with ${socialLegalProviders}. New accounts require legal acceptance on the Create Account tab.`}
                </Text>
              </TouchableOpacity>
              <View style={styles.orRow}>
                <View style={styles.orLine} />
                <Text style={styles.orText}>or</Text>
                <View style={styles.orLine} />
              </View>
            </View>
          )}

          {mode === 'signup' && (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TextInput
                testID="auth-first-name-input"
                ref={firstNameRef}
                style={[styles.input, { flex: 1 }]}
                placeholder="First name"
                placeholderTextColor={colors.textMuted}
                value={firstName}
                onChangeText={setFirstName}
                autoCapitalize="words"
                autoCorrect={false}
                returnKeyType="next"
                onSubmitEditing={() => lastNameRef.current?.focus()}
                blurOnSubmit={false}
              />
              <TextInput
                testID="auth-last-name-input"
                ref={lastNameRef}
                style={[styles.input, { flex: 1 }]}
                placeholder="Last name"
                placeholderTextColor={colors.textMuted}
                value={lastName}
                onChangeText={setLastName}
                autoCapitalize="words"
                autoCorrect={false}
                returnKeyType="next"
                onSubmitEditing={() => emailRef.current?.focus()}
                blurOnSubmit={false}
              />
            </View>
          )}

          {/* Email — hidden in reset_answer since the question is shown instead */}
          {mode !== 'reset_answer' && (
            <>
              <TextInput
                testID="auth-email-input"
                ref={emailRef}
                style={[styles.input, signupDisabled && styles.inputError]}
                placeholder="Email"
                placeholderTextColor={colors.textMuted}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType={mode === 'reset_email' ? 'go' : 'next'}
                onSubmitEditing={() => {
                  if (mode === 'reset_email') handleSubmit();
                  else if (mode === 'signup') usernameRef.current?.focus();
                  else passwordRef.current?.focus();
                }}
                blurOnSubmit={false}
              />
              {signupDisabled && (
                <FadeInView duration={200} slideDistance={4}>
                  <Text style={styles.inlineError}>Enter a valid email address</Text>
                </FadeInView>
              )}
            </>
          )}

          {/* Username (signup only) */}
          {mode === 'signup' && (
            <TextInput
              testID="auth-username-input"
              ref={usernameRef}
              style={styles.input}
              placeholder="Username"
              placeholderTextColor={colors.textMuted}
              value={username}
              onChangeText={(t) => setUsername(t.replace(/\s/g, '').toLowerCase())}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
              blurOnSubmit={false}
            />
          )}

          {/* Recovery question + answer (reset_answer only) */}
          {mode === 'reset_answer' && (
            <>
              <View style={styles.questionBox}>
                <Text style={styles.questionLabel}>Recovery question</Text>
                <Text style={styles.questionText}>{recoveryQuestion}</Text>
              </View>
              <TextInput
                testID="auth-recovery-answer-input"
                ref={answerRef}
                style={styles.input}
                placeholder="Your answer"
                placeholderTextColor={colors.textMuted}
                value={recoveryAnswer}
                onChangeText={setRecoveryAnswer}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
                onSubmitEditing={() => passwordRef.current?.focus()}
                blurOnSubmit={false}
              />
            </>
          )}

          {/* Password — hidden on reset_email step */}
          {mode !== 'reset_email' && (
            <View style={styles.passwordRow}>
              <TextInput
                testID="auth-password-input"
                ref={passwordRef}
                style={[styles.input, styles.passwordInput]}
                placeholder={mode === 'reset_answer' ? 'New password' : 'Password'}
                placeholderTextColor={colors.textMuted}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword && !maestroTestAccount}
                returnKeyType={mode === 'login' ? 'go' : 'next'}
                onSubmitEditing={() => mode === 'login' ? handleSubmit() : confirmPasswordRef.current?.focus()}
                blurOnSubmit={false}
              />
              <TouchableOpacity testID="auth-password-toggle" style={styles.eyeBtn} activeOpacity={0.75} hitSlop={{ top: 12, bottom: 12, left: 8, right: 12 }} onPress={() => setShowPassword(v => !v)}>
                <Text style={styles.eyeText}>{showPassword ? 'Hide' : 'Show'}</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Confirm password (signup + reset_answer) */}
          {(mode === 'signup' || mode === 'reset_answer') && (
            <View style={styles.passwordRow}>
              <TextInput
                testID="auth-confirm-password-input"
                ref={confirmPasswordRef}
                style={[styles.input, styles.passwordInput]}
                placeholder={mode === 'reset_answer' ? 'Confirm new password' : 'Confirm password'}
                placeholderTextColor={colors.textMuted}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry={!showConfirmPassword && !maestroTestAccount}
                returnKeyType="next"
                onSubmitEditing={() => mode === 'signup' ? answerRef.current?.focus() : handleSubmit()}
              />
              <TouchableOpacity testID="auth-confirm-password-toggle" style={styles.eyeBtn} activeOpacity={0.75} hitSlop={{ top: 12, bottom: 12, left: 8, right: 12 }} onPress={() => setShowConfirmPassword(v => !v)}>
                <Text style={styles.eyeText}>{showConfirmPassword ? 'Hide' : 'Show'}</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Recovery question — SIGNUP ONLY. Picked from a small preset
              list so users don't compose something they'll forget. The
              answer is required; password-reset uses this. */}
          {mode === 'signup' && (
            <>
              <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 2, marginTop: 4 }}>
                Security question · used to reset your password
              </Text>
              <Text style={{ fontSize: 10, color: colors.textMuted, marginBottom: 8, fontStyle: 'italic' }}>
                You can change this later from your profile settings.
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {[
                  "What was the name of your first pet?",
                  "What city were you born in?",
                  "What is your mother's maiden name?",
                  "What was your first car?",
                ].map(q => (
                  <TouchableOpacity
                    key={q}
                    onPress={() => setSignupRecoveryQuestion(q)}
                    style={{
                      paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
                      borderWidth: 1,
                      borderColor: signupRecoveryQuestion === q ? colors.primary : colors.border,
                      backgroundColor: signupRecoveryQuestion === q ? colors.primary + '22' : colors.surface,
                    }}
                  >
                    <Text style={{
                      fontSize: 11,
                      fontWeight: signupRecoveryQuestion === q ? '700' : '500',
                      color: signupRecoveryQuestion === q ? colors.primary : colors.textSecondary,
                    }}>
                      {q}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TextInput
                testID="auth-signup-recovery-answer-input"
                ref={answerRef}
                style={styles.input}
                placeholder="Your answer"
                placeholderTextColor={colors.textMuted}
                value={signupRecoveryAnswer}
                onChangeText={setSignupRecoveryAnswer}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="go"
                onSubmitEditing={handleSubmit}
              />
            </>
          )}

          {mode === 'signup' && (
            <View style={styles.legalBox}>
              <TouchableOpacity
                testID="auth-legal-accept"
                activeOpacity={0.75}
                style={styles.legalRow}
                onPress={() => setAcceptedLegal(v => !v)}
              >
                <View style={[styles.checkbox, acceptedLegal && styles.checkboxChecked]}>
                  {acceptedLegal ? <Text style={styles.checkboxMark}>✓</Text> : null}
                </View>
                <Text style={styles.legalText}>{legalAcceptanceLabel()}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowLegal(true)} style={styles.legalLinkBtn}>
                <Text style={styles.legalLink}>Read Terms, Privacy, Health, and AI disclosures</Text>
              </TouchableOpacity>
              <Text style={styles.passwordHint}>Password must be at least 8 characters and include a number.</Text>
            </View>
          )}

          {error ? (
            <FadeInView duration={220} slideDistance={6}>
              <Text style={styles.error}>{error}</Text>
            </FadeInView>
          ) : null}

          <TouchableOpacity
            testID="auth-submit"
            style={[styles.submitButton, (loading || signupDisabled) && styles.submitButtonDisabled]}
            onPress={handleSubmit}
            disabled={loading || signupDisabled}>
            {loading
              ? <ActivityIndicator color={colors.background} />
              : <Text style={styles.submitText}>
                  {mode === 'login'
                    ? 'Sign In'
                    : mode === 'reset_email'
                      ? 'Next'
                      : mode === 'reset_answer'
                        ? 'Reset Password'
                        : 'Create Account'}
                </Text>
            }
          </TouchableOpacity>

          {mode === 'login' && (
            <TouchableOpacity
              testID="auth-forgot-password"
              accessibilityLabel="auth-forgot-password"
              onPress={() => switchMode('reset_email')}
              style={styles.forgotBtn}>
              <Text style={styles.forgotText}>Forgot password?</Text>
            </TouchableOpacity>
          )}
          {mode === 'signup' && (
            <TouchableOpacity
              testID="auth-back-to-login"
              accessibilityLabel="auth-back-to-login"
              onPress={() => switchMode('login')}
              style={styles.forgotBtn}>
              <Text style={styles.forgotText}>Already have an account? Sign in</Text>
            </TouchableOpacity>
          )}
          {(mode === 'reset_email' || mode === 'reset_answer') && (
            <TouchableOpacity
              testID="auth-back-to-login"
              accessibilityLabel="auth-back-to-login"
              onPress={() => switchMode('login')}
              style={styles.forgotBtn}>
              <Text style={styles.forgotText}>Back to sign in</Text>
            </TouchableOpacity>
          )}
            </View>
          </View>
        </View>

        <View style={[styles.bottomSpacer, webMode && styles.webBottomSpacer]} />
      </ScrollView>
      <LegalDisclosureModal visible={showLegal} onClose={() => setShowLegal(false)} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: colors.background, overflow: 'hidden' },
  backgroundLayers: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  gradientWash: {
    position: 'absolute',
    left: -SCREEN_W * 0.22,
    right: -SCREEN_W * 0.22,
  },
  gradientWashPrimary: {
    top: 66,
    height: 330,
  },
  gradientWashSecondary: {
    bottom: 116,
    height: 280,
  },
  gradientRibbon: {
    position: 'absolute',
    top: 18,
    left: -SCREEN_W * 0.48,
    width: SCREEN_W * 1.96,
    height: 250,
  },
  gradientFloor: {
    position: 'absolute',
    left: -SCREEN_W * 0.38,
    right: -SCREEN_W * 0.38,
    bottom: -18,
    height: 310,
  },
  scroll: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 60, paddingBottom: 24 },
  webContent: {
    minHeight: '100%',
    paddingHorizontal: 32,
    paddingTop: 32,
    paddingBottom: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  webContentCompact: {
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 18,
    justifyContent: 'flex-start',
  },
  webShell: {
    width: '100%',
    maxWidth: 980,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 34,
  },
  webShellCompact: {
    maxWidth: 460,
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 0,
  },
  webIntroPanel: {
    flex: 1,
    maxWidth: 430,
    gap: 18,
    paddingVertical: 16,
  },
  webEyebrow: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  webIntroTitle: {
    color: colors.textPrimary,
    fontSize: 36,
    lineHeight: 42,
    fontWeight: '900',
    letterSpacing: 0,
  },
  webIntroBody: {
    color: colors.textSecondary,
    fontSize: 15,
    lineHeight: 23,
    fontWeight: '600',
    maxWidth: 390,
  },
  webIntroList: {
    gap: 10,
    marginTop: 2,
  },
  webIntroItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  webIntroIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.primary + '44',
    backgroundColor: colors.primary + '14',
  },
  webIntroItemText: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  webMarketingLink: {
    alignSelf: 'flex-start',
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface + 'A8',
  },
  webMarketingLinkText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '800',
  },
  webAuthPane: {
    width: 420,
    maxWidth: '100%',
  },

  logoContainer: { alignItems: 'center', marginTop: 20, marginBottom: 24 },
  logoContainerCompact: { marginTop: 0, marginBottom: 18 },
  webLogoContainer: {
    marginTop: 0,
    marginBottom: 12,
  },
  authBrandMark: {
    marginBottom: 14,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.24,
    shadowRadius: 24,
    elevation: 8,
  },
  authBrandMarkCompact: {
    marginBottom: 10,
  },
  backButton: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    marginBottom: 10,
  },
  webBackButton: {
    minHeight: 34,
    marginBottom: 8,
  },
  backButtonText: { color: colors.textPrimary, fontSize: 13, fontWeight: '800' },
  logo:          { width: SCREEN_W * 0.70, height: 130 },
  logoCompact:   { width: SCREEN_W * 0.48, height: 84 },
  webLogo:       { width: 188, height: 42 },
  authTitle:     { color: colors.textPrimary, fontSize: 22, lineHeight: 27, fontWeight: '900', textAlign: 'center', marginTop: 2 },
  webAuthTitle:  { fontSize: 24, lineHeight: 30 },
  tagline:       { fontSize: 15, color: colors.textSecondary, marginTop: 14, textAlign: 'center', fontWeight: '500', letterSpacing: 0.2 },
  featureRow:    { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14, justifyContent: 'center' },
  featureChip:   { backgroundColor: colors.surfaceRaised, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.border },
  featureChipText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
  subtag: { fontSize: 13, color: colors.textMuted, marginTop: 12, fontWeight: '500' },

  divider: { height: 1, backgroundColor: colors.border, marginBottom: 24 },
  webDivider: { opacity: 0, marginBottom: 0 },

  formCard: { gap: 12 },
  webFormCard: {
    gap: 10,
    padding: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface + 'F2',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.18,
    shadowRadius: 28,
    elevation: 8,
  },
  socialBlock: { gap: 10, marginBottom: 2 },
  socialRow: { flexDirection: 'row', gap: 10 },
  socialProviderButton: {
    flex: 1,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 8,
    overflow: 'hidden',
  },
  socialProviderButtonDisabled: { opacity: 0.62 },
  socialProviderText: {
    flexShrink: 1,
    color: '#111827',
    fontSize: 13,
    fontWeight: '800',
  },
  socialLegalText: {
    fontSize: 11,
    color: colors.textMuted,
    lineHeight: 15,
    textAlign: 'center',
  },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2 },
  orLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  orText: { fontSize: 11, color: colors.textMuted, fontWeight: '700', textTransform: 'uppercase' },

  toggle: {
    flexDirection: 'row',
    gap: 2,
    backgroundColor: colors.background,
    borderRadius: radius.full,
    padding: 3,
    marginBottom: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  toggleButton: {
    flex: 1, paddingVertical: 8, borderRadius: radius.full, alignItems: 'center',
  },
  toggleButtonActive: {
    backgroundColor: colors.primary + '22',
  },
  toggleText: {
    fontSize: 11, fontWeight: '500', color: colors.textMuted,
    letterSpacing: 0.7, textTransform: 'uppercase', opacity: 0.55,
  },
  toggleTextActive: { color: colors.primary, fontWeight: '700', opacity: 1 },

  trialBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderColor: colors.primary + '55',
    backgroundColor: colors.primary + '14',
    borderRadius: radius.md,
    padding: 12,
  },
  trialIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primary + '44',
  },
  trialTitle: { fontSize: 13, fontWeight: '900', color: colors.textPrimary, marginBottom: 2 },
  trialText: { fontSize: 11, lineHeight: 15, color: colors.textSecondary },

  signupFeaturePanel: {
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface + 'E6',
    borderRadius: radius.md,
    padding: 12,
    overflow: 'hidden',
  },
  signupFeatureHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  signupFeatureEyebrow: {
    fontSize: 10,
    fontWeight: '900',
    color: colors.primary,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  signupFeatureTitle: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '900',
    color: colors.textPrimary,
  },
  signupFeatureScroller: {
    marginHorizontal: -12,
  },
  signupFeatureScrollerContent: {
    gap: 10,
    paddingHorizontal: 12,
    paddingBottom: 1,
  },
  signupFeatureCard: {
    width: 158,
    height: 138,
    overflow: 'hidden',
    borderRadius: radius.md,
    justifyContent: 'space-between',
    padding: 10,
    backgroundColor: colors.surfaceRaised,
  },
  signupFeatureImage: {
    borderRadius: radius.md,
  },
  signupFeatureIcon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  signupFeatureCopy: {
    gap: 3,
  },
  signupFeatureCardTitle: {
    color: '#FFFFFF',
    fontSize: 13,
    lineHeight: 16,
    fontWeight: '900',
    textShadowColor: 'rgba(0,0,0,0.35)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 5,
  },
  signupFeatureCardBody: {
    color: 'rgba(255,255,255,0.86)',
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
  },

  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 16, fontSize: 16, backgroundColor: colors.surface, color: colors.textPrimary,
    letterSpacing: 0, fontWeight: '400',
  },

  passwordRow: { flexDirection: 'row', alignItems: 'center' },
  passwordInput: { flex: 1, borderTopRightRadius: 0, borderBottomRightRadius: 0, borderRightWidth: 0 },
  eyeBtn: {
    borderWidth: 1, borderColor: colors.border, borderLeftWidth: 0,
    borderTopRightRadius: radius.md, borderBottomRightRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: 14, justifyContent: 'center', alignSelf: 'stretch',
  },
  eyeText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },

  inputError: { borderColor: colors.error },
  inlineError: { fontSize: 12, color: colors.error, marginTop: -4 },
  error: { fontSize: 14, color: colors.error, textAlign: 'center' },
  legalBox: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    padding: 12,
    gap: 8,
  },
  legalRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkboxChecked: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  checkboxMark: { color: colors.background, fontSize: 14, fontWeight: '900', lineHeight: 18 },
  legalText: { flex: 1, fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  legalLinkBtn: { alignSelf: 'flex-start', paddingVertical: 2 },
  legalLink: { fontSize: 12, color: colors.primary, fontWeight: '700' },
  passwordHint: { fontSize: 11, color: colors.textMuted, lineHeight: 15 },

  submitButton: {
    backgroundColor: colors.primary, borderRadius: radius.md,
    paddingVertical: 17, alignItems: 'center', marginTop: 4,
    shadowColor: colors.primary, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 6, elevation: 4,
  },
  submitButtonDisabled: { opacity: 0.6 },
  submitText: { color: '#FFFFFF', fontSize: 17, fontWeight: '700', letterSpacing: 0.3 },

  forgotBtn: { alignSelf: 'center', paddingVertical: 8, marginTop: 2 },
  forgotText: { fontSize: 14, color: colors.textSecondary, fontWeight: '600' },

  questionBox: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 14, backgroundColor: colors.surfaceRaised,
  },
  questionLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.8, marginBottom: 4, textTransform: 'uppercase' },
  questionText: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  bottomSpacer: { height: 40 },
  webBottomSpacer: { height: 12 },
});
