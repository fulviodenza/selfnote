import { useCallback, useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { Connect } from "./src/Connect";
import { Library } from "./src/Library";
import { Reader } from "./src/Reader";
import { listBooks, type Book } from "./src/db";
import { loadConnection, type Connection } from "./src/selfnote";

type Screen = { name: "library" } | { name: "connect" } | { name: "reader"; book: Book };

export default function App() {
  const [books, setBooks] = useState<Book[]>([]);
  const [screen, setScreen] = useState<Screen>({ name: "library" });
  const [connection, setConnection] = useState<Connection | null>(null);

  const refresh = useCallback(() => {
    listBooks().then(setBooks).catch(() => setBooks([]));
  }, []);
  useEffect(refresh, [refresh]);
  // A stored connection is read once at launch. Failure is not worth surfacing:
  // it just means the reader stays local, which is a working state.
  useEffect(() => {
    loadConnection().then(setConnection).catch(() => setConnection(null));
  }, []);

  return (
    <>
      <StatusBar style="dark" />
      {screen.name === "reader" ? (
        <Reader
          book={screen.book}
          connection={connection}
          onClose={() => {
            refresh();
            setScreen({ name: "library" });
          }}
        />
      ) : screen.name === "connect" ? (
        <Connect
          current={connection}
          onDone={(c) => {
            setConnection(c);
            setScreen({ name: "library" });
          }}
          onClose={() => setScreen({ name: "library" })}
        />
      ) : (
        <Library
          books={books}
          connection={connection}
          onOpen={(book) => setScreen({ name: "reader", book })}
          onConnect={() => setScreen({ name: "connect" })}
          onChanged={refresh}
        />
      )}
    </>
  );
}
