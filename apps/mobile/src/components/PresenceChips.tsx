/**
 * Presence chips for the note topbar (mobile parity with the web editor).
 *
 * Shown only when there is presence to show: one chip per *other* client in the
 * room, and nothing at all when you are alone, which is the common case. A
 * permanent chip for the local user answered a question nobody asks, and gave
 * no way to tell whose name it was.
 *
 * Note: mobile does not publish its own awareness state yet. BlockNote runs
 * inside the WebView on its own Y.Doc and only document updates cross the
 * bridge, not the awareness protocol, so this sees web peers but they do not
 * see this device. Bridging awareness is separate work.
 */
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { DocConnection } from "@selfnote/core";
import { spacing } from "../theme";
import type { Palette, TypeRoles } from "../theme";
import { useTheme } from "../theme-context";

interface Peer {
  clientId: number;
  name: string;
  color: string;
}

/** The shape BlockNote's collaboration extension publishes into awareness. */
interface AwarenessState {
  user?: { name?: string; color?: string };
}

export function PresenceChips({ connection }: { connection: DocConnection }) {
  const { colors, type } = useTheme();
  const styles = useMemo(() => makeStyles(colors, type), [colors, type]);
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    const awareness = connection.provider.awareness;
    const read = () => {
      const next: Peer[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return; // never chip yourself
        const user = (state as AwarenessState)?.user;
        if (!user?.name) return; // a client that has not announced itself yet
        next.push({ clientId, name: user.name, color: user.color ?? colors.accent });
      });
      setPeers(next);
    };
    read();
    awareness.on("change", read);
    return () => awareness.off("change", read);
  }, [connection, colors.accent]);

  if (peers.length === 0) return null;

  /*
   * One name, then a count. The topbar is a non-wrapping row that also carries
   * the title, the tab count and up to five icon buttons; three full chips at
   * 120px each would eat a phone's whole width and push the trailing buttons
   * off the right edge, where they cannot be tapped. The container also
   * shrinks, so a long name yields before the buttons do.
   */
  const [first, ...rest] = peers;

  return (
    <View style={styles.wrap}>
      <View style={styles.chip}>
        <View style={[styles.dot, { backgroundColor: first.color }]} />
        <Text style={styles.name} numberOfLines={1}>
          {first.name}
        </Text>
      </View>
      {rest.length > 0 ? (
        <Text
          style={styles.more}
          accessibilityLabel={`and ${rest.length} more: ${rest.map((p) => p.name).join(", ")}`}
        >
          +{rest.length}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
    wrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
      flexShrink: 1,
      maxWidth: 140,
    },
    chip: { flexDirection: "row", alignItems: "center", gap: spacing.xs, flexShrink: 1 },
    dot: { width: 8, height: 8, borderRadius: 999, flexShrink: 0 },
    name: { ...type.meta, color: colors.ink, fontWeight: "600", flexShrink: 1 },
    more: { ...type.meta, color: colors.inkSoft, flexShrink: 0 },
  });
