import { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, ActivityIndicator, KeyboardAvoidingView,
  Platform, Image, Dimensions, Alert,
} from 'react-native';
import Constants from 'expo-constants';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons } from '@expo/vector-icons';
import { login, register, resetPassword, getRecoveryQuestion, setRecoveryQuestion, loginWithApple, loginWithGoogle } from '../services/api';
import { colors, radius } from '../constants/theme';
import FadeInView from '../components/FadeInView';
import LegalDisclosureModal from '../components/LegalDisclosureModal';
import { LEGAL_VERSION, legalAcceptanceLabel } from '../constants/legal';

const { width: SCREEN_W } = Dimensions.get('window');
const logo = require('../../assets/images/thallo-logo-white-transparent-New.png');

const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
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
}

export default function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  // Reset flow is two-step: 'reset_email' (enter email + fetch question) → 'reset_answer' (answer + new password)
  const [mode, setMode] = useState<'login' | 'signup' | 'reset_email' | 'reset_answer'>('login');
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

  const emailTouched = email.length > 0;
  const emailValid = EMAIL_RE.test(email.trim());
  const signupDisabled = mode === 'signup' && emailTouched && !emailValid;
  const maestroTestAccount = __DEV__ && email.trim().endsWith('@test.thallo');
  const showSocialSignIn = mode === 'login' || mode === 'signup';
  const showAppleSignIn = Platform.OS === 'ios' && showSocialSignIn;
  const socialVerb = mode === 'signup' ? 'Sign up' : 'Log in';
  const googleClientId = GOOGLE_OAUTH.webClientId
    ?? GOOGLE_OAUTH.iosClientId
    ?? GOOGLE_OAUTH.androidClientId
    ?? GOOGLE_CLIENT_ID_PLACEHOLDER;
  const activeGoogleClientId = Platform.select({
    ios: GOOGLE_OAUTH.iosClientId ?? GOOGLE_OAUTH.webClientId,
    android: GOOGLE_OAUTH.androidClientId ?? GOOGLE_OAUTH.webClientId,
    default: GOOGLE_OAUTH.webClientId ?? GOOGLE_OAUTH.iosClientId ?? GOOGLE_OAUTH.androidClientId,
  });
  const googleConfigured = !!activeGoogleClientId;
  const [googleRequest, googleResponse, promptGoogleAsync] = Google.useIdTokenAuthRequest({
    clientId: googleClientId,
    webClientId: GOOGLE_OAUTH.webClientId ?? googleClientId,
    iosClientId: GOOGLE_OAUTH.iosClientId ?? googleClientId,
    androidClientId: GOOGLE_OAUTH.androidClientId ?? googleClientId,
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
            acceptedTerms: true,
            acceptedPrivacy: true,
            acceptedHealthDisclaimer: true,
            acceptedAiDisclaimer: true,
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
  }, [googleResponse]);

  const handleGoogleSignIn = async () => {
    if (loading) return;
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
        acceptedTerms: true,
        acceptedPrivacy: true,
        acceptedHealthDisclaimer: true,
        acceptedAiDisclaimer: true,
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
        await register(email.trim(), username.trim(), password, {
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
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}>

        {/* Logo */}
        <View style={styles.logoContainer}>
          <Image source={logo} style={styles.logo} resizeMode="contain" />
          <Text style={styles.tagline}>Personalized training, nutrition, and AI coaching.</Text>
          <View style={styles.featureRow}>
            {(['Personalized training plans', 'Nutrition support', 'AI coaching that adapts'] as const).map(f => (
              <View key={f} style={styles.featureChip}>
                <Text style={styles.featureChipText}>{f}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.subtag}>Set up in under 3 minutes</Text>
        </View>

        <View style={styles.divider} />

        {/* Auth form */}
        <View style={styles.formCard}>
          {/* Login / Sign Up toggle — sliding pill indicator */}
          <View style={styles.toggle}>
            <TouchableOpacity
              testID="auth-mode-login"
              activeOpacity={0.75}
              style={[styles.toggleButton, mode === 'login' && styles.toggleButtonActive]}
              onPress={() => switchMode('login')}>
              <Text style={[styles.toggleText, mode === 'login' && styles.toggleTextActive]}>Log In</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="auth-mode-signup"
              activeOpacity={0.75}
              style={[styles.toggleButton, mode === 'signup' && styles.toggleButtonActive]}
              onPress={() => switchMode('signup')}>
              <Text style={[styles.toggleText, mode === 'signup' && styles.toggleTextActive]}>Sign Up</Text>
            </TouchableOpacity>
          </View>

          {showSocialSignIn && (
            <View style={styles.socialBlock}>
              <View style={styles.socialRow}>
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
                    {socialVerb} with Google
                  </Text>
                </TouchableOpacity>
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
                      {socialVerb} with Apple
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
              <TouchableOpacity onPress={() => setShowLegal(true)} activeOpacity={0.75}>
                <Text style={styles.socialLegalText}>
                  By continuing with {showAppleSignIn ? 'Google or Apple' : 'Google'}, you accept Thallo's Terms, Privacy Policy, Health Disclaimer, and AI Disclosure.
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
              onChangeText={setUsername}
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
                    ? 'Log In'
                    : mode === 'reset_email'
                      ? 'Next'
                      : mode === 'reset_answer'
                        ? 'Reset Password'
                        : 'Get Started'}
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
              <Text style={styles.forgotText}>Already have an account? Log in</Text>
            </TouchableOpacity>
          )}
          {(mode === 'reset_email' || mode === 'reset_answer') && (
            <TouchableOpacity
              testID="auth-back-to-login"
              accessibilityLabel="auth-back-to-login"
              onPress={() => switchMode('login')}
              style={styles.forgotBtn}>
              <Text style={styles.forgotText}>Back to log in</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
      <LegalDisclosureModal visible={showLegal} onClose={() => setShowLegal(false)} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 60, paddingBottom: 24 },

  logoContainer: { alignItems: 'center', marginTop: 20, marginBottom: 24 },
  logo:          { width: SCREEN_W * 0.70, height: 130 },
  tagline:       { fontSize: 15, color: colors.textSecondary, marginTop: 14, textAlign: 'center', fontWeight: '500', letterSpacing: 0.2 },
  featureRow:    { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14, justifyContent: 'center' },
  featureChip:   { backgroundColor: colors.surfaceRaised, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.border },
  featureChipText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
  subtag: { fontSize: 13, color: colors.textMuted, marginTop: 12, fontWeight: '500' },

  divider: { height: 1, backgroundColor: colors.border, marginBottom: 24 },

  formCard: { gap: 12 },
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

  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 16, fontSize: 16, backgroundColor: colors.surface, color: colors.textPrimary,
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
});
