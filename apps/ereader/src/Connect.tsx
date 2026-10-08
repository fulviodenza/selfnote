/**
 * Connecting a Selfnote instance. Entirely optional: the reader works without
 * ever opening this screen, and disconnecting leaves every local feature intact.
 */
import { useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { connect, disconnect, saveConnection, type Connection } from "./selfnote";

export function Connect({
  current,
  onDone,
  onClose,
}: {
  current: Connection | null;
  onDone: (c: Connection | null) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(current ? current.baseUrl.replace(/\/api$/, "") : "");
  const [email, setEmail] = useState(current?.email ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await connect(url, email, password);
      await saveConnection(c);
      setPassword("");
      onDone(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    await disconnect();
    onDone(null);
  };

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <TouchableOpacity onPress={onClose} hitSlop={12}>
          <Text style={styles.back}>Done</Text>
        </TouchableOpacity>

        <Text style={styles.title}>Send highlights to Selfnote</Text>
        <Text style={styles.blurb}>
          Optional. Reading and highlighting work without this, and everything stays on the
          device until you connect.
        </Text>

        {current ? (
          <View style={styles.connected}>
            <Text style={styles.connectedTo}>Connected to {current.baseUrl.replace(/\/api$/, "")}</Text>
            <Text style={styles.connectedAs}>as {current.email}</Text>
            <TouchableOpacity style={styles.secondary} onPress={unlink}>
              <Text style={styles.secondaryText}>Disconnect</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <Text style={styles.label}>Your Selfnote address</Text>
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          placeholder="selfnote.example.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          inputMode="url"
        />

        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          inputMode="email"
        />

        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          onSubmitEditing={submit}
          returnKeyType="go"
        />
        <Text style={styles.hint}>
          Used once to sign in. The app stores a revocable access token instead, and never
          keeps your password.
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.primary, busy && styles.primaryBusy]}
          onPress={submit}
          disabled={busy}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Connect</Text>}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#faf5ef" },
  body: { padding: 28, paddingTop: 64, gap: 6 },
  back: { fontSize: 16, color: "#3730c4", fontWeight: "600", marginBottom: 18 },
  title: { fontSize: 26, fontWeight: "700", color: "#1b1b1b" },
  blurb: { fontSize: 15, lineHeight: 22, color: "#6b6b6b", marginBottom: 14 },
  connected: {
    padding: 16, borderRadius: 12, backgroundColor: "#eef3ea",
    borderWidth: 1, borderColor: "#d6e0cf", marginBottom: 18,
  },
  connectedTo: { fontSize: 15, fontWeight: "600", color: "#1b1b1b" },
  connectedAs: { fontSize: 14, color: "#6b6b6b", marginTop: 2 },
  label: { fontSize: 14, fontWeight: "600", color: "#1b1b1b", marginTop: 14 },
  input: {
    borderWidth: 1, borderColor: "#e0d8cb", borderRadius: 10, backgroundColor: "#fffdfa",
    paddingHorizontal: 14, paddingVertical: 13, fontSize: 16, color: "#1b1b1b",
  },
  hint: { fontSize: 13, lineHeight: 19, color: "#8a8a8a", marginTop: 8 },
  error: { fontSize: 14, color: "#b3261e", marginTop: 14 },
  primary: {
    marginTop: 26, paddingVertical: 16, borderRadius: 12,
    backgroundColor: "#3730c4", alignItems: "center",
  },
  primaryBusy: { opacity: 0.7 },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  secondary: { marginTop: 12, paddingVertical: 10, alignItems: "center" },
  secondaryText: { color: "#b3261e", fontSize: 15, fontWeight: "600" },
});
