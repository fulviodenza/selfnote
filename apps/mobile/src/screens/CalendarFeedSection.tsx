/**
 * "Calendar feed" section for workspace settings. Mirrors the web calendar-feed
 * card: enable → issue a one-time cal_… token + URL, copy the URL, "Add to
 * calendar" opens the webcal:// URL in the OS calendar via Linking, plus Rotate
 * and Disable. The plaintext token is shown once (only right after issuing).
 *
 * See docs/features/calendar-task-sync.md §5.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { api, type CalendarFeedInfo } from "../api";
import { getSettings } from "../settings";
import { radius, spacing } from "../theme";
import type { Palette, TypeRoles } from "../theme";
import { useTheme } from "../theme-context";
import { Button, useToast } from "../ui";

/** Absolute ICS URL from a server-relative feed path. */
function absoluteUrl(relative: string): string {
  return `${getSettings().apiUrl}${relative}`;
}

/** webcal:// variant so the OS hands the subscription to the calendar app. */
function webcalUrl(relative: string): string {
  return absoluteUrl(relative).replace(/^https?:\/\//, "webcal://");
}

export function CalendarFeedSection({ workspaceId }: { workspaceId: string }) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const toast = useToast();
  const [info, setInfo] = useState<CalendarFeedInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // The full URL is only knowable right after issuing (one-time token). We keep
  // it in state so Copy / Add-to-calendar work until the sheet is dismissed.
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setInfo(await api.getCalendarFeed(workspaceId));
    } catch {
      setInfo({ enabled: false });
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const issue = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.issueCalendarFeed(workspaceId);
      setIssuedUrl(res.url);
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message.slice(0, 120) : "Couldn't enable the feed.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.revokeCalendarFeed(workspaceId);
      setIssuedUrl(null);
      await refresh();
      toast("Calendar feed disabled.");
    } catch (e) {
      toast(e instanceof Error ? e.message.slice(0, 120) : "Couldn't disable the feed.");
    } finally {
      setBusy(false);
    }
  };

  // The working URL: the one-time issued URL if we just minted it, else the
  // display URL the server reports (may be absent — then only Rotate reveals it).
  const displayUrl = issuedUrl ?? info?.url ?? null;

  const copy = async () => {
    if (!displayUrl) return;
    await Clipboard.setStringAsync(absoluteUrl(displayUrl));
    toast("Feed URL copied.");
  };

  const addToCalendar = async () => {
    if (!displayUrl) return;
    const url = webcalUrl(displayUrl);
    try {
      await Linking.openURL(url);
    } catch {
      toast("No calendar app could open the feed.");
    }
  };

  return (
    <View style={styles.card}>
      <Text style={type.label}>Calendar feed</Text>

      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ alignSelf: "flex-start" }} />
      ) : !info?.enabled ? (
        <>
          <Text style={[type.meta, { color: colors.inkSoft }]}>
            Publish a read-only iCal feed so your tasks show up in Google, Apple, or Outlook
            calendars.
          </Text>
          <Button label="Enable calendar feed" onPress={issue} loading={busy} />
        </>
      ) : (
        <>
          {issuedUrl ? (
            <Text style={[type.meta, { color: colors.warn }]}>
              Copy this URL now — it contains a secret token shown only once.
            </Text>
          ) : (
            <Text style={[type.meta, { color: colors.inkSoft }]}>
              A feed is active. Rotate to reveal a fresh URL (the old one stops working).
            </Text>
          )}

          {displayUrl ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Feed URL"
              onPress={copy}
              style={styles.urlBox}
            >
              <Text style={[type.meta, { color: colors.ink }]} numberOfLines={2} selectable>
                {absoluteUrl(displayUrl)}
              </Text>
            </Pressable>
          ) : null}

          {displayUrl ? (
            <View style={styles.actionRow}>
              <View style={styles.flex}>
                <Button variant="secondary" label="Copy URL" onPress={copy} />
              </View>
              <View style={styles.flex}>
                <Button variant="secondary" label="Add to calendar" onPress={addToCalendar} />
              </View>
            </View>
          ) : null}

          <View style={styles.actionRow}>
            <View style={styles.flex}>
              <Button variant="secondary" label="Rotate" onPress={issue} loading={busy} />
            </View>
            <View style={styles.flex}>
              <Button variant="destructive" label="Disable" onPress={disable} />
            </View>
          </View>
        </>
      )}
    </View>
  );
}

const makeStyles = (colors: Palette, _type: TypeRoles) =>
  StyleSheet.create({
    flex: { flex: 1 },
    card: {
      gap: spacing.md,
      paddingTop: spacing.md,
      borderTopWidth: 1,
      borderTopColor: colors.hairline,
    },
    urlBox: {
      backgroundColor: colors.surfaceSunken,
      borderRadius: radius.sm,
      padding: spacing.md,
    },
    actionRow: { flexDirection: "row", gap: spacing.sm },
  });
