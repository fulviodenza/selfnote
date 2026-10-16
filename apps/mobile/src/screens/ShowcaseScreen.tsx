/**
 * Component showcase: every ui/ primitive and the feature pieces built on them,
 * in the current theme, with a switch to flip light and dark. Opened from
 * Settings. Keep it in step with the web showcase (apps/web/showcase.html).
 */
import { useMemo, useState } from "react";
import { Feather } from "@expo/vector-icons";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { radius, spacing, type Palette, type TypeRoles } from "../theme";
import { useTheme } from "../theme-context";
import { Button, Chip, IconButton, Input, Row, StatusDot, useToast } from "../ui";
import { CALLOUT_ICON, CALLOUT_KINDS, calloutColors } from "../editor/AssistDrawer";
import { PriorityMark } from "./PriorityMark";

const SWATCHES: Array<keyof Palette> = [
  "paper",
  "surface",
  "surfaceSunken",
  "ink",
  "inkSoft",
  "inkFaint",
  "hairline",
  "accent",
  "accentWash",
  "live",
  "warn",
  "danger",
];

export function ShowcaseScreen({ onClose }: { onClose: () => void }) {
  const { colors, type, isDark, setMode } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const toast = useToast();
  const [filter, setFilter] = useState("all");

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={styles.screen}>
        <View style={styles.topbar}>
          <IconButton icon="x" label="Close showcase" onPress={onClose} />
          <Text style={[type.docTitle, styles.grow]}>Components</Text>
          <IconButton
            icon={isDark ? "sun" : "moon"}
            label={isDark ? "Show light theme" : "Show dark theme"}
            onPress={() => setMode(isDark ? "light" : "dark")}
          />
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <Text style={[type.meta, styles.lead]}>
            Ink and Paper: warm paper, slate ink, one cobalt accent. Live, warn and danger mean sync
            state and destructive actions, never decoration.
          </Text>

          <Section title="Colour" styles={styles}>
            <View style={styles.swatches}>
              {SWATCHES.map((k) => (
                <View key={k} style={styles.swatch}>
                  <View style={[styles.swatchColor, { backgroundColor: colors[k] }]} />
                  <Text style={type.meta}>{k}</Text>
                </View>
              ))}
            </View>
          </Section>

          <Section title="Type" styles={styles}>
            <Text style={type.title}>Screen title</Text>
            <Text style={type.docTitle}>Page title</Text>
            <Text style={type.body}>Body text for controls and inputs.</Text>
            <Text style={type.label}>Label</Text>
            <Text style={type.meta}>Meta, timestamps and counts</Text>
          </Section>

          <Section title="Buttons" styles={styles}>
            <Button label="Create page" icon="plus" onPress={() => toast("Primary pressed")} />
            <Button variant="secondary" label="Cancel" onPress={() => undefined} />
            <Button variant="ghost" label="Need an account? Register" onPress={() => undefined} />
            <Button variant="destructive" label="Delete" onPress={() => undefined} />
            <Button label="Disabled" disabled onPress={() => undefined} />
            <View style={styles.inline}>
              <IconButton icon="settings" label="Settings" onPress={() => undefined} />
              <IconButton icon="star" label="Active" active onPress={() => undefined} />
              <IconButton icon="trash-2" label="Delete" tone="danger" onPress={() => undefined} />
            </View>
          </Section>

          <Section title="Chips" styles={styles}>
            <View style={styles.wrap}>
              {["all", "todo", "in progress", "done"].map((f) => (
                <Chip key={f} label={f === "all" ? "All" : f[0].toUpperCase() + f.slice(1)} selected={filter === f} onPress={() => setFilter(f)} />
              ))}
            </View>
          </Section>

          <Section title="Tasks" styles={styles}>
            {(["high", "medium", "low"] as const).map((p) => (
              <View key={p} style={styles.inline}>
                <PriorityMark priority={p} />
                <Text style={type.body}>{p[0].toUpperCase() + p.slice(1)} priority</Text>
              </View>
            ))}
          </Section>

          <Section title="Inputs" styles={styles}>
            <Input label="Server URL" placeholder="https://notes.example.com" />
            <Input label="Email" value="not an email" error="Enter a valid email" />
          </Section>

          <Section title="Rows" styles={styles}>
            <View style={styles.card}>
              <Row onPress={() => undefined}>
                <Text style={type.docTitle}>Projects</Text>
              </Row>
              <Row onPress={() => undefined} selected indent={1}>
                <Text style={type.docTitle}>Writing</Text>
              </Row>
              <Row onPress={() => undefined}>
                <Text style={type.docTitle}>Reading list</Text>
              </Row>
            </View>
          </Section>

          <Section title="Callouts" styles={styles}>
            {CALLOUT_KINDS.map((k) => {
              const c = calloutColors(colors, k);
              return (
                <View key={k} style={[styles.callout, { borderColor: c.accent, backgroundColor: c.wash }]}>
                  <Feather name={CALLOUT_ICON[k]} size={18} color={c.accent} />
                  <Text style={[type.body, styles.grow]}>
                    <Text style={{ fontWeight: "600" }}>{k[0].toUpperCase() + k.slice(1)}.</Text> Callout body text.
                  </Text>
                </View>
              );
            })}
          </Section>

          <Section title="Sync status" styles={styles}>
            <StatusDot state="connected" />
            <StatusDot state="connecting" />
            <StatusDot state="disconnected" />
            <StatusDot state="offline" />
          </Section>

          <Section title="Feedback" styles={styles}>
            <Button
              variant="secondary"
              label="Show a toast"
              onPress={() => toast("Link copied", { actionLabel: "Undo", onAction: () => undefined })}
            />
          </Section>

          <Section title="Empty state" styles={styles}>
            <View style={[styles.card, styles.empty]}>
              <Text style={type.docTitle}>Nothing here yet.</Text>
              <Button label="Create your first page" onPress={() => undefined} />
            </View>
          </Section>
        </ScrollView>
      </View>
    </Modal>
  );
}

function Section({
  title,
  styles,
  children,
}: {
  title: string;
  styles: ReturnType<typeof makeStyles>;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.paper },
    topbar: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      minHeight: 56,
      paddingHorizontal: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.hairline,
    },
    grow: { flex: 1 },
    content: { padding: spacing.gutter, paddingBottom: spacing.huge, gap: spacing.xxl },
    lead: { color: colors.inkSoft },
    section: { gap: spacing.md },
    sectionTitle: { ...type.label, color: colors.inkSoft },
    swatches: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
    swatch: { width: 96, gap: spacing.xs },
    swatchColor: {
      height: 40,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.hairline,
    },
    inline: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    wrap: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.hairline,
      overflow: "hidden",
    },
    empty: { alignItems: "center", gap: spacing.lg, padding: spacing.xxl },
    callout: {
      flexDirection: "row",
      gap: spacing.md,
      padding: spacing.md,
      borderWidth: 1,
      borderLeftWidth: 4,
      borderRadius: radius.md,
    },
  });
