import { useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, ActivityIndicator, KeyboardAvoidingView,
  Platform, Image, Dimensions, Alert,
} from 'react-native';
import { login, register } from '../services/api';
import { colors, radius } from '../constants/theme';

const { width: SCREEN_W } = Dimensions.get('window');
const logo = require('../../assets/images/Apple dumbbell logo with _MAKROS_ text.png');

interface AuthScreenProps {
  onAuthenticated: (token: string, isNewUser: boolean) => void;
}

export default function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const usernameRef        = useRef<TextInput>(null);
  const passwordRef        = useRef<TextInput>(null);
  const confirmPasswordRef = useRef<TextInput>(null);
  const scrollRef          = useRef<ScrollView>(null);

  const switchMode = (next: 'login' | 'signup') => {
    setMode(next);
    setError('');
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
    setShowConfirmPassword(false);
  };

  const handleSubmit = async () => {
    setError('');
    if (!email.trim() || !password.trim()) {
      setError('Email and password are required');
      return;
    }
    if (mode === 'signup') {
      if (!username.trim()) {
        setError('Username is required');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match');
        return;
      }
      if (password.length < 6) {
        setError('Password must be at least 6 characters');
        return;
      }
    }
    setLoading(true);
    try {
      const isNewUser = mode === 'signup';
      if (isNewUser) await register(email.trim(), username.trim(), password);
      const { access_token } = await login(email.trim(), password);

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
          <Text style={styles.tagline}>AI-powered fitness, built around you.</Text>
          <View style={styles.featureRow}>
            {(['Smart workout plans', 'Nutrition tracking', 'Real-time AI coaching'] as const).map(f => (
              <View key={f} style={styles.featureChip}>
                <Text style={styles.featureChipText}>{f}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.divider} />

        {/* Auth form */}
        <View style={styles.formCard}>
          {/* Login / Sign Up toggle */}
          <View style={styles.toggle}>
            <TouchableOpacity
              style={[styles.toggleButton, mode === 'login' && styles.toggleActive]}
              onPress={() => switchMode('login')}>
              <Text style={[styles.toggleText, mode === 'login' && styles.toggleTextActive]}>Log In</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toggleButton, mode === 'signup' && styles.toggleActive]}
              onPress={() => switchMode('signup')}>
              <Text style={[styles.toggleText, mode === 'signup' && styles.toggleTextActive]}>Sign Up</Text>
            </TouchableOpacity>
          </View>

          {/* Email */}
          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor={colors.textMuted}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
            onSubmitEditing={() => mode === 'signup' ? usernameRef.current?.focus() : passwordRef.current?.focus()}
            blurOnSubmit={false}
          />

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

          {/* Password */}
          <View style={styles.passwordRow}>
            <TextInput
              ref={passwordRef}
              style={[styles.input, styles.passwordInput]}
              placeholder="Password"
              placeholderTextColor={colors.textMuted}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              returnKeyType={mode === 'signup' ? 'next' : 'go'}
              onSubmitEditing={() => mode === 'signup' ? confirmPasswordRef.current?.focus() : handleSubmit()}
              blurOnSubmit={false}
            />
            <TouchableOpacity style={styles.eyeBtn} onPress={() => setShowPassword(v => !v)}>
              <Text style={styles.eyeText}>{showPassword ? 'Hide' : 'Show'}</Text>
            </TouchableOpacity>
          </View>

          {/* Confirm password (signup only) */}
          {mode === 'signup' && (
            <View style={styles.passwordRow}>
              <TextInput
                ref={confirmPasswordRef}
                style={[styles.input, styles.passwordInput]}
                placeholder="Confirm password"
                placeholderTextColor={colors.textMuted}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry={!showConfirmPassword}
                returnKeyType="go"
                onSubmitEditing={handleSubmit}
              />
              <TouchableOpacity style={styles.eyeBtn} onPress={() => setShowConfirmPassword(v => !v)}>
                <Text style={styles.eyeText}>{showConfirmPassword ? 'Hide' : 'Show'}</Text>
              </TouchableOpacity>
            </View>
          )}

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TouchableOpacity
            style={[styles.submitButton, loading && styles.submitButtonDisabled]}
            onPress={handleSubmit}
            disabled={loading}>
            {loading
              ? <ActivityIndicator color={colors.background} />
              : <Text style={styles.submitText}>
                  {mode === 'login' ? 'Log In' : 'Create Account'}
                </Text>
            }
          </TouchableOpacity>
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

  logoContainer: { alignItems: 'center', marginBottom: 24 },
  logo:          { width: SCREEN_W * 0.88, height: SCREEN_W * 0.88 * 0.44 },
  tagline:       { fontSize: 15, color: colors.textSecondary, marginTop: 14, textAlign: 'center', fontWeight: '500', letterSpacing: 0.2 },
  featureRow:    { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14, justifyContent: 'center' },
  featureChip:   { backgroundColor: colors.surfaceRaised, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.border },
  featureChipText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },

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
  },
  toggleButton:     { flex: 1, paddingVertical: 12, borderRadius: radius.full, alignItems: 'center' },
  toggleActive:     { backgroundColor: colors.primary, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 3 },
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

  error: { fontSize: 14, color: colors.error, textAlign: 'center' },

  submitButton: {
    backgroundColor: colors.primary, borderRadius: radius.md,
    paddingVertical: 17, alignItems: 'center', marginTop: 4,
    shadowColor: colors.primary, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 6, elevation: 4,
  },
  submitButtonDisabled: { opacity: 0.6 },
  submitText: { color: '#FFFFFF', fontSize: 17, fontWeight: '700', letterSpacing: 0.3 },
});
