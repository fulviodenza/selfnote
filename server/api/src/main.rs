//! Selfnote API server (Phase 2).
//!
//! Control plane: auth, workspaces, the document/page tree, and room-token issuance.
//! Stateless over Postgres; the sync server handles live CRDT traffic separately.

mod ai;
mod auth;
mod documents;
mod error;
mod files;
mod history;
mod links;
mod proposals;
mod rooms;
mod shares;
mod state;
mod tasks;
mod workspaces;

use std::net::SocketAddr;

use axum::routing::{delete, get, post};
use axum::Router;
use sqlx::postgres::PgPoolOptions;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "selfnote_api=info,tower_http=info,sqlx=warn".into()),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://selfnote:selfnote@localhost:5432/selfnote".to_string());

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await?;

    sqlx::migrate!("../migrations").run(&pool).await?;
    tracing::info!("migrations applied");

    // Pre-upgrade hook mode: apply migrations and exit (gates rollouts).
    if std::env::var("MIGRATE_ONLY").is_ok() {
        tracing::info!("MIGRATE_ONLY set — migrations done, exiting");
        return Ok(());
    }

    let state = AppState::from_env(pool)?;

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/ai/status", get(ai::status))
        .route("/ai/complete", post(ai::complete))
        .route("/ai/chat", post(ai::chat))
        .route("/ai/chat/stream", post(ai::chat_stream))
        .route("/ai/action", post(ai::action))
        .route("/ai/action/stream", post(ai::action_stream))
        .route("/ai/voice", get(ai::get_voice).put(ai::set_voice))
        .route("/ai/proposals", get(proposals::list).post(proposals::create))
        .route("/ai/proposals/:id", get(proposals::get))
        .route("/ai/proposals/:id/accept", post(proposals::accept))
        .route("/ai/proposals/:id/reject", post(proposals::reject))
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/refresh", post(auth::refresh))
        .route("/auth/tokens", get(auth::list_tokens).post(auth::create_token))
        .route("/auth/tokens/:id", delete(auth::delete_token))
        .route("/workspaces", get(workspaces::list).post(workspaces::create))
        .route("/workspaces/:id/members", post(workspaces::add_member))
        .route("/documents", get(documents::list).post(documents::create))
        .route("/documents/search", get(documents::search))
        .route("/documents/recent", get(documents::recent))
        .route("/documents/link-search", get(links::link_search))
        .route("/documents/:id", get(documents::get).patch(documents::update))
        .route("/documents/:id/viewed", post(documents::mark_viewed))
        .route(
            "/documents/:id/links",
            get(links::links).put(links::set_links),
        )
        .route("/documents/:id/backlinks", get(links::backlinks))
        .route("/workspaces/:id/graph", get(links::graph))
        .route(
            "/documents/:id/content",
            get(documents::get_content).post(documents::set_content),
        )
        .route(
            "/documents/:id/history",
            get(history::list).post(history::create),
        )
        .route(
            "/documents/:id/history/:checkpoint_id",
            get(history::get).delete(history::delete),
        )
        .route(
            "/documents/:id/history/:checkpoint_id/restore",
            post(history::restore),
        )
        .route(
            "/documents/:id/task",
            get(tasks::get_task)
                .post(tasks::set_task)
                .patch(tasks::update_task)
                .delete(tasks::delete_task),
        )
        .route("/tasks", get(tasks::list_tasks))
        .route(
            "/workspaces/:id/calendar-feed",
            get(tasks::get_feed)
                .post(tasks::issue_feed)
                .delete(tasks::revoke_feed),
        )
        .route("/calendar/:workspace_id/:token", get(tasks::ics_feed))
        .route("/documents/:id/room-token", post(rooms::issue))
        .route("/documents/:id/shares", get(shares::list).post(shares::create))
        .route("/shares/:id", get(shares::resolve))
        .route("/shares/:id/analytics", get(shares::analytics))
        .route(
            "/files",
            post(files::upload).layer(axum::extract::DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        .route("/files/:id", get(files::download))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr: SocketAddr = std::env::var("API_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:4445".to_string())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("selfnote-api listening on http://{addr}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
