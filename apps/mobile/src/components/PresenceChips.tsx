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

  return (
    <View style={styles.wrap}>
      {peers.map((p) => (
        <View key={p.clientId} style={styles.chip}>
          <View style={[styles.dot, { backgroundColor: p.color }]} />
          <Text style={styles.name} numberOfLines={1}>
            {p.name}
          </Text>
        </View>
      ))}
    </View>
  );
}

const makeStyles = (colors: Palette, type: TypeRoles) =>
  StyleSheet.create({
    wrap: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    chip: { flexDirection: "row", alignItems: "center", gap: spacing.xs, maxWidth: 120 },
    dot: { width: 8, height: 8, borderRadius: 999 },
    name: { ...type.meta, color: colors.ink, fontWeight: "600", flexShrink: 1 },
  });
