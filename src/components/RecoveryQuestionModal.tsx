import { useState } from 'react';
import {
  View, Text, Modal, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, ScrollView, KeyboardAvoidingView, Platform,
} from 'react-native';
import { colors, radius } from '../constants/theme';
import { setRecoveryQuestion } from '../services/api';

interface Props {
  visible: boolean;
  authToken: string;
  onDone: () => void;
}

const PRESET_QUESTIONS = [
  'What was the name of your first pet?',
  'What city were you born in?',
  'What is your mother\'s maiden name?',
  'What was the make of your first car?',
  'What was the name of your elementary school?',
  'What is the name of your best childhood friend?',
];

export default function RecoveryQuestionModal({ visible, authToken, onDone }: Props) {
  const [useCustom, setUseCustom] = useState(false);
  const [question, setQuestion] = useState(PRESET_QUESTIONS[0]);
  const [customQuestion, setCustomQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    setError('');
    const q = useCustom ? customQuestion.trim() : question;
    const a = answer.trim();
    if (q.length < 5) { setError('Question must be at least 5 characters'); return; }
    if (a.length < 2) { setError('Answer must be at least 2 characters'); return; }
    setLoading(true);
    try {
      await setRecoveryQuestion(authToken, q, a);
      onDone();
    } catch (e: any) {
      setError(e?.message ?? 'Unable to save. Try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent={false}>
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title}>Set a recovery question</Text>
          <Text style={styles.subtitle}>
            If you forget your password, we'll ask this question to verify it's
            you. No email required. Choose something you won't forget.
          </Text>

          <View style={styles.toggleRow}>
            <TouchableOpacity
              style={[styles.toggleBtn, !useCustom && styles.toggleBtnActive]}
              onPress={() => setUseCustom(false)}
            >
              <Text style={[styles.toggleText, !useCustom && styles.toggleTextActive]}>
                Pick one
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toggleBtn, useCustom && styles.toggleBtnActive]}
              onPress={() => setUseCustom(true)}
            >
              <Text style={[styles.toggleText, useCustom && styles.toggleTextActive]}>
                Write my own
              </Text>
            </TouchableOpacity>
          </View>

          {!useCustom ? (
            <View style={styles.presetList}>
              {PRESET_QUESTIONS.map((q) => (
                <TouchableOpacity
                  key={q}
                  style={[styles.presetRow, question === q && styles.presetRowActive]}
                  onPress={() => setQuestion(q)}
                >
                  <Text style={[styles.presetText, question === q && styles.presetTextActive]}>
                    {q}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : (
            <TextInput
              style={styles.input}
              placeholder="Your question"
              placeholderTextColor={colors.textMuted}
              value={customQuestion}
              onChangeText={setCustomQuestion}
              autoCapitalize="sentences"
              returnKeyType="next"
            />
          )}

          <Text style={styles.label}>Your answer</Text>
          <TextInput
            style={styles.input}
            placeholder="Answer"
            placeholderTextColor={colors.textMuted}
            value={answer}
            onChangeText={setAnswer}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={handleSubmit}
          />
          <Text style={styles.hint}>
            Not case-sensitive. Whitespace ignored.
          </Text>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TouchableOpacity
            style={[styles.submit, loading && styles.submitDisabled]}
            disabled={loading}
            onPress={handleSubmit}
          >
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.submitText}>Save</Text>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: 24, paddingTop: 80, paddingBottom: 40 },
  title: { fontSize: 24, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  subtitle: { fontSize: 14, color: colors.textSecondary, lineHeight: 20, marginBottom: 20 },

  toggleRow: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.full,
    padding: 3,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  toggleBtn: { flex: 1, paddingVertical: 10, borderRadius: radius.full, alignItems: 'center' },
  toggleBtnActive: { backgroundColor: colors.primary },
  toggleText: { fontSize: 14, fontWeight: '600', color: colors.textMuted },
  toggleTextActive: { color: '#fff', fontWeight: '700' },

  presetList: { gap: 8, marginBottom: 16 },
  presetRow: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 14, backgroundColor: colors.surface,
  },
  presetRowActive: { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
  presetText: { fontSize: 14, color: colors.textSecondary, fontWeight: '500' },
  presetTextActive: { color: colors.textPrimary, fontWeight: '700' },

  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 14, fontSize: 16, backgroundColor: colors.surface, color: colors.textPrimary,
    marginBottom: 4,
  },
  label: { fontSize: 13, fontWeight: '700', color: colors.textSecondary, marginTop: 12, marginBottom: 6, letterSpacing: 0.5 },
  hint: { fontSize: 12, color: colors.textMuted, marginTop: 4 },
  error: { fontSize: 14, color: colors.error, textAlign: 'center', marginTop: 12 },

  submit: {
    backgroundColor: colors.primary, borderRadius: radius.md,
    paddingVertical: 16, alignItems: 'center', marginTop: 20,
  },
  submitDisabled: { opacity: 0.6 },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
