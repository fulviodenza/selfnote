//! In-memory room registry. Each room owns one Yjs document and relays updates
//! between the WebSocket connections currently joined to it.
//!
//! Phase 1 is deliberately memory-only: when the last client leaves and the idle
//! grace period passes, the room (and its doc) is dropped. Clients are the source
//! of truth and rehydrate the server on reconnect. Phase 2 adds Postgres-backed
//! persistence + snapshot compaction behind this same interface.

use std::collections::HashMap;
use std::sync::Mutex;

use dashmap::DashMap;
use tokio::sync::mpsc::UnboundedSender;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

use crate::protocol;
use crate::store::Store;

/// A single collaborative document and its live connections.
pub struct Room {
    doc: Mutex<Doc>,
    conns: Mutex<HashMap<u64, UnboundedSender<Vec<u8>>>>,
    /// Last raw awareness message seen from each connection, replayed to joiners.
    awareness: Mutex<HashMap<u64, Vec<u8>>>,
    /// Guards one-time hydration of the doc from persistent storage.
    loaded: tokio::sync::Mutex<bool>,
}

impl Room {
    fn new() -> Self {
        Self {
            doc: Mutex::new(Doc::new()),
            conns: Mutex::new(HashMap::new()),
            awareness: Mutex::new(HashMap::new()),
            loaded: tokio::sync::Mutex::new(false),
        }
    }

    /// Hydrate the document from storage exactly once, before serving clients.
    pub async fn ensure_loaded(&self, store: &dyn Store, doc_id: &str) {
        let mut loaded = self.loaded.lock().await;
        if *loaded {
            return;
        }
        match store.load(doc_id).await {
            Ok(Some(state)) => {
                if let Err(e) = self.apply_update(&state) {
                    tracing::warn!(doc = doc_id, "failed to hydrate doc: {e}");
                }
            }
            Ok(None) => {}
            Err(e) => tracing::warn!(doc = doc_id, "store load failed: {e}"),
        }
        *loaded = true;
    }

    pub fn add_conn(&self, id: u64, tx: UnboundedSender<Vec<u8>>) {
        self.conns.lock().unwrap().insert(id, tx);
    }

    /// Remove a connection; returns true if the room is now empty.
    pub fn remove_conn(&self, id: u64) -> bool {
        self.awareness.lock().unwrap().remove(&id);
        let mut conns = self.conns.lock().unwrap();
        conns.remove(&id);
        conns.is_empty()
    }

    /// Current document state vector, encoded (lib0 v1). Sent as SyncStep1.
    pub fn state_vector_v1(&self) -> Vec<u8> {
        let doc = self.doc.lock().unwrap();
        let txn = doc.transact();
        txn.state_vector().encode_v1()
    }

    /// Encode the diff the peer is missing, given its state vector. Sent as SyncStep2.
    pub fn diff_from_state_vector(&self, sv_bytes: &[u8]) -> Option<Vec<u8>> {
        let sv = StateVector::decode_v1(sv_bytes).ok()?;
        let doc = self.doc.lock().unwrap();
        let txn = doc.transact();
        Some(txn.encode_state_as_update_v1(&sv))
    }

    /// Apply an incoming update to the authoritative server copy.
    pub fn apply_update(&self, update_bytes: &[u8]) -> anyhow::Result<()> {
        let update = Update::decode_v1(update_bytes)?;
        let doc = self.doc.lock().unwrap();
        let mut txn = doc.transact_mut();
        txn.apply_update(update)?;
        Ok(())
    }

    /// Relay a document update to everyone except its origin connection.
    pub fn relay_update(&self, from: u64, update_bytes: &[u8]) {
        let msg = protocol::message_sync_update(update_bytes);
        let conns = self.conns.lock().unwrap();
        for (id, tx) in conns.iter() {
            if *id != from {
                let _ = tx.send(msg.clone());
            }
        }
    }

    /// Record and relay a raw awareness message (broadcast verbatim to others).
    pub fn on_awareness(&self, from: u64, raw: Vec<u8>) {
        self.awareness.lock().unwrap().insert(from, raw.clone());
        let conns = self.conns.lock().unwrap();
        for (id, tx) in conns.iter() {
            if *id != from {
                let _ = tx.send(raw.clone());
            }
        }
    }

    /// Snapshot of every other connection's last awareness message, for a joiner.
    pub fn awareness_snapshot(&self, except: u64) -> Vec<Vec<u8>> {
        self.awareness
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| **id != except)
            .map(|(_, raw)| raw.clone())
            .collect()
    }
}

/// Registry mapping document ids to live rooms.
pub struct Rooms {
    map: DashMap<String, std::sync::Arc<Room>>,
}

impl Rooms {
    pub fn new() -> Self {
        Self { map: DashMap::new() }
    }

    pub fn get_or_create(&self, name: &str) -> std::sync::Arc<Room> {
        self.map
            .entry(name.to_string())
            .or_insert_with(|| std::sync::Arc::new(Room::new()))
            .clone()
    }

    /// Drop the room if it has no remaining connections.
    pub fn remove_if_empty(&self, name: &str) {
        self.map
            .remove_if(name, |_, room| room.conns.lock().unwrap().is_empty());
    }
}
