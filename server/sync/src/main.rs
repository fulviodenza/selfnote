//! Selfnote sync server.
//!
//! A WebSocket hub that speaks the Yjs sync protocol. Each `/ws/:doc` connection
//! joins a room; the server relays CRDT updates between peers and keeps an
//! authoritative copy so late joiners sync from a single SyncStep exchange.
//!
//! Optional (enabled by env):
//!   * DATABASE_URL       → persist updates to Postgres + compact snapshots
//!   * SYNC_REQUIRE_AUTH  → require a valid room token (issued by the API) to join

mod protocol;
mod room;
mod store;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures::{SinkExt, StreamExt};
use selfnote_common::{RoomClaims, RoomMode};
use sqlx::postgres::PgPoolOptions;
use tokio::sync::mpsc;

use crate::room::{Room, Rooms};
use crate::store::{MemoryStore, PgStore, Store};

static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);

struct Config {
    require_auth: bool,
    room_secret: Vec<u8>,
    store: Arc<dyn Store>,
}

struct AppServer {
    rooms: Rooms,
    cfg: Config,
}

type Shared = Arc<AppServer>;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "selfnote_sync=info".into()),
        )
        .init();

    let store: Arc<dyn Store> = match std::env::var("DATABASE_URL") {
        Ok(url) => {
            let pool = PgPoolOptions::new().max_connections(5).connect(&url).await?;
            tracing::info!("persistence enabled (Postgres)");
            Arc::new(PgStore::new(pool))
        }
        Err(_) => {
            tracing::info!("persistence disabled (memory-only)");
            Arc::new(MemoryStore)
        }
    };

    let require_auth = std::env::var("SYNC_REQUIRE_AUTH").is_ok_and(|v| v == "1" || v == "true");
    let room_secret = std::env::var("ROOM_SECRET")
        .unwrap_or_else(|_| "dev-insecure-room-secret".to_string())
        .into_bytes();
    if require_auth {
        tracing::info!("room-token auth required");
    }

    let server = Arc::new(AppServer {
        rooms: Rooms::new(),
        cfg: Config {
            require_auth,
            room_secret,
            store,
        },
    });

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/ws/:doc", get(ws_handler))
        .with_state(server);

    let addr: SocketAddr = std::env::var("SYNC_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:4444".to_string())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("selfnote-sync listening on ws://{addr}/ws/:doc");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown signal received");
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(doc): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    State(server): State<Shared>,
) -> Response {
    // Authorize the join if room-token auth is enabled.
    let mut read_only = false;
    if server.cfg.require_auth {
        let token = params.get("token");
        match token.and_then(|t| {
            selfnote_common::verify::<RoomClaims>(t, &server.cfg.room_secret).ok()
        }) {
            Some(claims) if claims.doc == doc => {
                read_only = claims.mode == RoomMode::ReadOnly;
            }
            _ => return (StatusCode::UNAUTHORIZED, "invalid room token").into_response(),
        }
    }

    ws.on_upgrade(move |socket| handle_socket(socket, doc, server, read_only))
}

async fn handle_socket(socket: WebSocket, doc_name: String, server: Shared, read_only: bool) {
    let room = server.rooms.get_or_create(&doc_name);
    // Hydrate from storage before serving this client (runs once per room).
    room.ensure_loaded(server.cfg.store.as_ref(), &doc_name).await;

    let conn_id = NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed);
    tracing::debug!(conn_id, doc = %doc_name, read_only, "client joined");

    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    room.add_conn(conn_id, tx.clone());

    let (mut sink, mut stream) = socket.split();
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(Message::Binary(msg)).await.is_err() {
                break;
            }
        }
    });

    let _ = tx.send(protocol::message_sync_step1(&room.state_vector_v1()));
    for a in room.awareness_snapshot(conn_id) {
        let _ = tx.send(a);
    }

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Binary(data) => {
                handle_message(&server, &room, conn_id, &doc_name, read_only, &tx, &data)
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    let now_empty = room.remove_conn(conn_id);
    writer.abort();
    if now_empty {
        // Compact the log now that the room is idle, then drop it.
        if let Err(e) = server.cfg.store.compact(&doc_name).await {
            tracing::warn!(doc = %doc_name, "compaction failed: {e}");
        }
        server.rooms.remove_if_empty(&doc_name);
    }
    tracing::debug!(conn_id, doc = %doc_name, "client left");
}

#[allow(clippy::too_many_arguments)]
fn handle_message(
    server: &Shared,
    room: &Room,
    conn_id: u64,
    doc_name: &str,
    read_only: bool,
    out: &mpsc::UnboundedSender<Vec<u8>>,
    data: &[u8],
) {
    let mut pos = 0;
    let Some(msg_type) = protocol::read_var_uint(data, &mut pos) else {
        return;
    };

    match msg_type {
        protocol::MSG_SYNC => {
            let Some(sync_type) = protocol::read_var_uint(data, &mut pos) else {
                return;
            };
            match sync_type {
                protocol::SYNC_STEP1 => {
                    if let Some(sv) = protocol::read_var_u8_array(data, &mut pos) {
                        if let Some(diff) = room.diff_from_state_vector(sv) {
                            let _ = out.send(protocol::message_sync_step2(&diff));
                        }
                    }
                }
                protocol::SYNC_STEP2 | protocol::SYNC_UPDATE => {
                    if read_only {
                        return; // viewers cannot mutate the document
                    }
                    if let Some(update) = protocol::read_var_u8_array(data, &mut pos) {
                        match room.apply_update(update) {
                            Ok(()) => {
                                room.relay_update(conn_id, update);
                                // Persist asynchronously; CRDT order-independence
                                // makes detached appends safe.
                                let store = server.cfg.store.clone();
                                let doc = doc_name.to_string();
                                let bytes = update.to_vec();
                                tokio::spawn(async move {
                                    if let Err(e) = store.persist(&doc, &bytes).await {
                                        tracing::warn!(doc = %doc, "persist failed: {e}");
                                    }
                                });
                            }
                            Err(e) => tracing::warn!(conn_id, "bad update: {e}"),
                        }
                    }
                }
                _ => {}
            }
        }
        protocol::MSG_AWARENESS => {
            room.on_awareness(conn_id, data.to_vec());
        }
        protocol::MSG_QUERY_AWARENESS => {
            for a in room.awareness_snapshot(conn_id) {
                let _ = out.send(a);
            }
        }
        _ => {}
    }
}
