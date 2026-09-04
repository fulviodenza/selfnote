/**
 * React Native stub for y-indexeddb.
 *
 * @selfnote/core imports IndexeddbPersistence at module load to expose the web
 * persistence factory, but on mobile we pass the SQLite factory explicitly, so it
 * is never constructed. IndexedDB doesn't exist in React Native, and the real
 * package pulls in browser globals, so we alias it to this no-op via metro.config.js.
 */
export class IndexeddbPersistence {
  constructor() {
    throw new Error("IndexeddbPersistence is not available on React Native");
  }
}
