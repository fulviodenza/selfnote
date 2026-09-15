/**
 * Presence chips for the editor topbar.
 *
 * The topbar used to show a randomly generated name for the local user at all
 * times, which answered a question nobody asks: knowing you are "Alan 67" to
 * other people is not useful while you are alone in a document, and there was
 * no way to tell whether the name was yours or somebody else's.
 *
 * So presence is shown only when there is presence to show. This renders one
 * chip per *other* client in the room and nothing at all when you are alone,
 * which is the common case.
 *
 * The local user still gets a generated name and colour: Yjs awareness needs
 * them to paint remote cursors. It is simply no longer a permanent label.
 */
import { useEffect, useState } from "react";
import type { DocConnection } from "@selfnote/core";
import { Icon } from "./Icon";

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
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    const awareness = connection.provider.awareness;
    const read = () => {
      const next: Peer[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return; // never chip yourself
        const user = (state as AwarenessState)?.user;
        if (!user?.name) return; // a client that has not announced itself yet
        next.push({ clientId, name: user.name, color: user.color ?? "var(--accent)" });
      });
      setPeers(next);
    };
    read();
    awareness.on("change", read);
    return () => awareness.off("change", read);
  }, [connection]);

  if (peers.length === 0) return null;

  return (
    <span className="presence">
      {peers.map((p) => (
        <span key={p.clientId} className="presence-chip" style={{ color: p.color }}>
          <Icon name="circle-filled" size={8} /> {p.name}
        </span>
      ))}
    </span>
  );
}
