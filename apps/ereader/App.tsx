import { useCallback, useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { Library } from "./src/Library";
import { Reader } from "./src/Reader";
import { listBooks, type Book } from "./src/db";

export default function App() {
  const [books, setBooks] = useState<Book[]>([]);
  const [open, setOpen] = useState<Book | null>(null);

  const refresh = useCallback(() => {
    listBooks().then(setBooks).catch(() => setBooks([]));
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <>
      <StatusBar style="dark" />
      {open ? (
        <Reader book={open} onClose={() => setOpen(null)} />
      ) : (
        <Library books={books} onOpen={setOpen} onChanged={refresh} />
      )}
    </>
  );
}
