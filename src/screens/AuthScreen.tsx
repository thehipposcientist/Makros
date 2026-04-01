import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, ActivityIndicator, KeyboardAvoidingView,
  Platform, Image,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { login, register } from '../services/api';
import { colors, radius } from '../constants/theme';

const logo = require('../../assets/images/logo.png');

interface AuthScreenProps {
  onAuthenticated: (token: string) => void;
}

export default function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const switchMode = (next: 'login' | 'signup') => {
    setMode(next);
    setError('');
  };

  const handleSubmit = async () => {
    setError('');
    if (!email.trim() || !password.trim()) {
      setError('Email and password are required');
      return;
    }
    if (mode === 'signup' && !username.trim()) {
      setError('Username is required');
      return;
    }
    setLoading(true);
    try {
      if (mode === 'signup') {
        await register(email.trim(), username.trim(), password);
      }
      const { access_token } = await login(email.trim(), password);
      await AsyncStorage.setItem('authToken', access_token);
      onAuthenticated(access_token);
    } catch (e: any) {
      setError(e.message ?? 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">

        <View style={styles.logoContainer}>
          <Image source={logo} style={styles.logo} resizeMode="contain" />
          <Text style={styles.tagline}>Track smarter. Eat better. Move more.</Text>
        </View>

        <View style={styles.toggle}>
          <TouchableOpacity
            style={[styles.toggleButton, mode === 'login' && styles.toggleActive]}
            onPress={() => switchMode('login')}>
            <Text style={[styles.toggleText, mode === 'login' && styles.toggleTextActive]}>
              Log In
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggleButton, mode === 'signup' && styles.toggleActive]}
            onPress={() => switchMode('signup')}>
            <Text style={[styles.toggleText, mode === 'signup' && styles.toggleTextActive]}>
              Sign Up
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.form}>
          <TextInput
            style={styles.input} placeholder="Email" placeholderTextColor={colors.textMuted}
            value={email} onChangeText={setEmail}
            keyboardType="email-address" autoCapitalize="none" autoCorrect={false}
          />
          {mode === 'signup' && (
            <TextInput
              style={styles.input} placeholder="Username" placeholderTextColor={colors.textMuted}
              value={username} onChangeText={setUsername}
              autoCapitalize="none" autoCorrect={false}
            />
          )}
          <TextInput
            style={styles.input} placeholder="Password" placeholderTextColor={colors.textMuted}
            value={password} onChangeText={setPassword} secureTextEntry
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TouchableOpacity
            style={[styles.submitButton, loading && styles.submitButtonDisabled]}
            onPress={handleSubmit} disabled={loading}>
            {loading
              ? <ActivityIndicator color={colors.background} />
              : <Text style={styles.submitText}>
                  {mode === 'login' ? 'Log In' : 'Create Account'}
                </Text>
            }
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container:  { flex: 1, backgroundColor: colors.background },
  content:    { flexGrow: 1, justifyContent: 'center', padding: 28, paddingBottom: 60 },

  logoContainer: { alignItems: 'center', marginBottom: 48 },
  logo:          { width: 500, height: 200 },
  tagline:       { fontSize: 14, color: colors.textSecondary, marginTop: 12, textAlign: 'center' },

  toggle: {
    flexDirection: 'row', backgroundColor: colors.surface,
    borderRadius: radius.md, padding: 4, marginBottom: 28,
    borderWidth: 1, borderColor: colors.border,
  },
  toggleButton:     { flex: 1, paddingVertical: 12, borderRadius: radius.sm, alignItems: 'center' },
  toggleActive:     { backgroundColor: colors.primary },
  toggleText:       { fontSize: 15, fontWeight: '500', color: colors.textSecondary },
  toggleTextActive: { color: colors.background, fontWeight: '700' },

  form:  { gap: 14 },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 16, fontSize: 16, backgroundColor: colors.surface, color: colors.textPrimary,
  },
  error:        { fontSize: 14, color: colors.error, textAlign: 'center' },
  submitButton: {
    backgroundColor: colors.primary, borderRadius: radius.md,
    paddingVertical: 16, alignItems: 'center', marginTop: 4,
  },
  submitButtonDisabled: { opacity: 0.6 },
  submitText:   { color: colors.background, fontSize: 16, fontWeight: '700' },
});
