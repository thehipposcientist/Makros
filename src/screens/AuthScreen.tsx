import { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, ActivityIndicator, KeyboardAvoidingView,
  Platform, Image, Dimensions, Alert, Animated,
} from 'react-native';
import { login, register, resetPassword, getRecoveryQuestion, setRecoveryQuestion } from '../services/api';
import { colors, radius } from '../constants/theme';
import FadeInView from '../components/FadeInView';

const { width: SCREEN_W } = Dimensions.get('window');
const logo = require('../../assets/images/thallo-logo-white.png');

const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

interface AuthScreenProps {
  onAuthenticated: (token: string, isNewUser: boolean) => void;
}

export default function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  // Reset flow is two-step: 'reset_email' (enter email + fetch question) → 'reset_answer' (answer + new password)
  const [mode, setMode] = useState<'login' | 'signup' | 'reset_email' | 'reset_answer'>('login');
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const emailTouched = email.length > 0;
  const emailValid = EMAIL_RE.test(email.trim());
  const signupDisabled = mode === 'signup' && emailTouched && !emailValid;

  const usernameRef        = useRef<TextInput>(null);
  const passwordRef        = useRef<TextInput>(null);
  const confirmPasswordRef = useRef<TextInput>(null);
  const answerRef          = useRef<TextInput>(null);
  const scrollRef          = useRef<ScrollView>(null);

  // Sliding pill indicator behind the Login/Sign Up toggle. 0 = login,
  // 1 = signup. Reset modes share the login slot so the pill stays parked.
  const togglePos = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(togglePos, {
      toValue: mode === 'signup' ? 1 : 0,
      duration: 220,
      useNativeDriver: false,
    }).start();
  }, [mode, togglePos]);

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

  const handleSubmit = async () => {
    setError('');
    // Reset step 1: look up question
    if (mode === 'reset_email') {
      if (!email.trim()) { setError('Enter your email'); return; }
      setLoading(true);
      try {
        const { question } = await getRecoveryQuestion(email.trim());
        setRecoveryQuestion(question);
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
      if (!username.trim()) { setError('Username is required'); return; }
      if (password !== confirmPassword) { setError('Passwords do not match'); return; }
      if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
      if (!signupRecoveryAnswer.trim() || signupRecoveryAnswer.trim().length < 2) {
        setError("Please answer your security question — you'll need it to reset your password");
        return;
      }
    }
    setLoading(true);
    try {
      const isNewUser = mode === 'signup';
      if (isNewUser) await register(email.trim(), username.trim(), password);
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
          <Text style={styles.tagline}>Your AI personal trainer and nutritionist.</Text>
          <View style={styles.featureRow}>
            {(['Custom workout plans', 'Personalised nutrition', 'AI coaching that adapts'] as const).map(f => (
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
            <Animated.View
              pointerEvents="none"
              style={[styles.toggleIndicator, {
                left: togglePos.interpolate({ inputRange: [0, 1], outputRange: ['0%', '50%'] }),
              }]}
            />
            <TouchableOpacity
              activeOpacity={0.75}
              style={styles.toggleButton}
              onPress={() => switchMode('login')}>
              <Text style={[styles.toggleText, mode === 'login' && styles.toggleTextActive]}>Log In</Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.75}
              style={styles.toggleButton}
              onPress={() => switchMode('signup')}>
              <Text style={[styles.toggleText, mode === 'signup' && styles.toggleTextActive]}>Sign Up</Text>
            </TouchableOpacity>
          </View>

          {/* Email — hidden in reset_answer since the question is shown instead */}
          {mode !== 'reset_answer' && (
            <>
              <TextInput
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
                ref={passwordRef}
                style={[styles.input, styles.passwordInput]}
                placeholder={mode === 'reset_answer' ? 'New password' : 'Password'}
                placeholderTextColor={colors.textMuted}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                returnKeyType={mode === 'login' ? 'go' : 'next'}
                onSubmitEditing={() => mode === 'login' ? handleSubmit() : confirmPasswordRef.current?.focus()}
                blurOnSubmit={false}
              />
              <TouchableOpacity style={styles.eyeBtn} activeOpacity={0.75} hitSlop={{ top: 12, bottom: 12, left: 8, right: 12 }} onPress={() => setShowPassword(v => !v)}>
                <Text style={styles.eyeText}>{showPassword ? 'Hide' : 'Show'}</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Confirm password (signup + reset_answer) */}
          {(mode === 'signup' || mode === 'reset_answer') && (
            <View style={styles.passwordRow}>
              <TextInput
                ref={confirmPasswordRef}
                style={[styles.input, styles.passwordInput]}
                placeholder={mode === 'reset_answer' ? 'Confirm new password' : 'Confirm password'}
                placeholderTextColor={colors.textMuted}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry={!showConfirmPassword}
                returnKeyType="next"
                onSubmitEditing={() => mode === 'signup' ? answerRef.current?.focus() : handleSubmit()}
              />
              <TouchableOpacity style={styles.eyeBtn} activeOpacity={0.75} hitSlop={{ top: 12, bottom: 12, left: 8, right: 12 }} onPress={() => setShowConfirmPassword(v => !v)}>
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

          {error ? (
            <FadeInView duration={220} slideDistance={6}>
              <Text style={styles.error}>{error}</Text>
            </FadeInView>
          ) : null}

          <TouchableOpacity
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
            <TouchableOpacity onPress={() => switchMode('reset_email')} style={styles.forgotBtn}>
              <Text style={styles.forgotText}>Forgot password?</Text>
            </TouchableOpacity>
          )}
          {(mode === 'reset_email' || mode === 'reset_answer') && (
            <TouchableOpacity onPress={() => switchMode('login')} style={styles.forgotBtn}>
              <Text style={styles.forgotText}>Back to log in</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
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

  toggle: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.full,
    padding: 3,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: colors.border,
    position: 'relative',
  },
  toggleIndicator: {
    position: 'absolute',
    top: 3,
    bottom: 3,
    width: '50%',
    backgroundColor: colors.primary,
    borderRadius: radius.full,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  toggleButton:     { flex: 1, paddingVertical: 12, borderRadius: radius.full, alignItems: 'center' },
  toggleText:       { fontSize: 15, fontWeight: '600', color: colors.textMuted },
  toggleTextActive: { color: '#FFFFFF', fontWeight: '700' },

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
