/**
 * "My writing voice" section for Settings — mobile parity with the web voice
 * settings. Backed by GET/PUT /ai/voice: a multiline sample of the user's own
 * writing that grounds the "Rewrite in my voice" note action. Empty clears it
 * (falls back to a generic rewrite); the server caps the sample at 8000 chars.
 *
 * Rendered only when /ai/status reports a provider (gated by the caller).
 */
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from "react-native";
import { api } from "../api";
import { radius, spacing } from "../theme";
import type { Palette, TypeRoles } from "../theme";
import { useTheme } from "../theme-context";
import { Button, useToast } from "../ui";

const MAX = 8000;

export function VoiceSection() {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const toast = useToast();
  const [sample, setSample] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getVoice()
      .then((v) => alive && setSample(v.sample))
      .catch(() => undefined)
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      const v = await api.setVoice(sample.slice(0, MAX));
      setSample(v.sample);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      toast("Couldn't save your voice sample.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.section}>
      <Text style={type.label}>My writing voice</Text>
      <Text style={[type.meta, styles.hint]}>
        Paste 1–3 paragraphs of your own writing. It powers “Rewrite in my voice”. Leave empty for a
        generic rewrite.
      </Text>
      {loading ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <>
          <TextInput
            value={sample}
            onChangeText={(t) => setSample(t.slice(0, MAX))}
            placeholder="A few sentences that sound like you…"
            placeholderTextColor={colors.inkSoft}
            multiline
            textAlignVertical="top"
            style={styles.input}
          />
          <Button label={saved ? "Saved ✓" : "Save voice"} onPress={save} loading={busy} />
        </>
      )}
    </View>
  );
}

const makeStyles = (colors: Palette, _type: TypeRoles) =>
  StyleSheet.create({
    section: { gap: spacing.sm },
    hint: {},
    input: {
      minHeight: 120,
      maxHeight: 220,
      borderWidth: 1,
      borderColor: colors.hairline,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      color: colors.ink,
      fontSize: 16,
      backgroundColor: colors.surface,
    },
  });
