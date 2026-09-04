//! AI backend detection + completion.
//!
//! Server-owned: the mobile/web client only surfaces "Assist" when `/ai/status`
//! reports a provider, so a plain instance shows no dead buttons. Detection is
//! cheap and cached for the process lifetime. Provider resolution order:
//!   1. a local `claude` (or `$SELFNOTE_AI_CMD`) binary on PATH — data stays on
//!      the server;
//!   2. `$ANTHROPIC_API_KEY` — the Claude API;
//!   3. `$OLLAMA_HOST` — a local open-weights model.
//!
//! Configure the model with `$SELFNOTE_AI_MODEL`. Chat (`/ai/chat`, `/ai/chat/stream`)
//! reuses the same providers, streaming replies token-by-token over SSE.

use std::convert::Infallible;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::auth::AuthUser;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;

const FEATURES: [&str; 5] = ["continue", "summarize", "ideas", "improve", "ask"];
const MAX_CONTEXT_CHARS: usize = 24_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
enum Provider {
    ClaudeCli { cmd: String, model: String },
    AnthropicApi { model: String },
    Ollama { host: String, model: String },
    None,
}

static PROVIDER: OnceLock<Provider> = OnceLock::new();

fn provider() -> &'static Provider {
    PROVIDER.get_or_init(detect)
}

fn detect() -> Provider {
    let model = std::env::var("SELFNOTE_AI_MODEL").ok();

    // The `claude` CLI is bundled in the image, so having it on PATH is not enough
    // to choose it — that would shadow the API-key / Ollama paths. Pick the CLI only
    // when it's actually usable: a subscription token is provided, or the operator
    // explicitly opted in by setting SELFNOTE_AI_CMD.
    let explicit_cmd = std::env::var("SELFNOTE_AI_CMD").ok();
    let has_cli_token = std::env::var("CLAUDE_CODE_OAUTH_TOKEN").is_ok();
    let cmd = explicit_cmd.clone().unwrap_or_else(|| "claude".to_string());
    if (has_cli_token || explicit_cmd.is_some()) && binary_on_path(&cmd) {
        return Provider::ClaudeCli {
            cmd,
            model: model.unwrap_or_else(|| "claude".to_string()),
        };
    }
    if std::env::var("ANTHROPIC_API_KEY").is_ok() {
        return Provider::AnthropicApi {
            model: model.unwrap_or_else(|| "claude-sonnet-4-5".to_string()),
        };
    }
    if let Ok(host) = std::env::var("OLLAMA_HOST") {
        return Provider::Ollama {
            host: host.trim_end_matches('/').to_string(),
            model: model.unwrap_or_else(|| "llama3".to_string()),
        };
    }
    Provider::None
}

fn binary_on_path(name: &str) -> bool {
    if name.contains('/') {
        return Path::new(name).exists();
    }
    std::env::var("PATH")
        .ok()
        .map(|path| path.split(':').any(|dir| Path::new(dir).join(name).exists()))
        .unwrap_or(false)
}

/* --------------------------------------------------------------- status --- */

#[derive(Debug, Serialize)]
pub struct AiStatus {
    pub available: bool,
    pub provider: Option<&'static str>,
    pub model: Option<String>,
    pub features: Vec<&'static str>,
}

pub async fn status(State(_state): State<AppState>, _user: AuthUser) -> Json<AiStatus> {
    let (available, provider_name, model) = match provider() {
        Provider::ClaudeCli { model, .. } => (true, Some("claude-cli"), Some(model.clone())),
        Provider::AnthropicApi { model } => (true, Some("anthropic-api"), Some(model.clone())),
        Provider::Ollama { model, .. } => (true, Some("ollama"), Some(model.clone())),
        Provider::None => (false, None, None),
    };
    Json(AiStatus {
        available,
        provider: provider_name,
        model,
        features: if available { FEATURES.to_vec() } else { Vec::new() },
    })
}

/* ------------------------------------------------------------- complete --- */

#[derive(Debug, Deserialize)]
pub struct CompleteReq {
    pub doc_id: Option<uuid::Uuid>,
    pub intent: String,
    pub prompt: Option<String>,
    pub selection: Option<String>,
    pub context: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CompleteResp {
    pub text: String,
}

fn instruction_for(req: &CompleteReq) -> &str {
    match req.intent.as_str() {
        "continue" => "Continue writing this document naturally from where it ends. Return only the new prose to append, no preamble.",
        "summarize" => "Summarize this document as a few concise bullet points.",
        "ideas" => "Suggest a short, concrete list of ideas or next points to add to this document.",
        "improve" => "Rewrite the selected passage to be clearer and tighter. Return only the rewritten text.",
        _ => req.prompt.as_deref().unwrap_or("Help improve this document."),
    }
}

fn build_prompt(req: &CompleteReq) -> String {
    let mut p = String::from(instruction_for(req));
    if let Some(sel) = req.selection.as_deref().filter(|s| !s.trim().is_empty()) {
        p.push_str("\n\nSelected passage:\n");
        p.push_str(truncate(sel));
    }
    if let Some(ctx) = req.context.as_deref().filter(|s| !s.trim().is_empty()) {
        p.push_str("\n\nDocument:\n");
        p.push_str(truncate(ctx));
    }
    p
}

/// Keep the tail of the document (most relevant to "continue") within budget.
fn truncate(s: &str) -> &str {
    if s.len() <= MAX_CONTEXT_CHARS {
        return s;
    }
    let start = s.len() - MAX_CONTEXT_CHARS;
    // Snap to a char boundary.
    let start = (start..s.len()).find(|&i| s.is_char_boundary(i)).unwrap_or(s.len());
    &s[start..]
}

pub async fn complete(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CompleteReq>,
) -> ApiResult<Json<CompleteResp>> {
    // If the request references a document, the caller must belong to its workspace
    // — the AI must not become a way to read documents you can't otherwise access.
    if let Some(doc_id) = req.doc_id {
        let ws: Option<(uuid::Uuid,)> =
            sqlx::query_as("select workspace_id from documents where id = $1")
                .bind(doc_id)
                .fetch_optional(&state.pool)
                .await?;
        let workspace_id = ws.ok_or(AppError::NotFound)?.0;
        crate::workspaces::member_role(&state, workspace_id, user.id)
            .await?
            .ok_or(AppError::Forbidden)?;
    }

    let prompt = build_prompt(&req);
    let text = match provider() {
        Provider::ClaudeCli { cmd, .. } => run_cli(cmd, &prompt).await?,
        Provider::AnthropicApi { model } => run_anthropic(model, &prompt).await?,
        Provider::Ollama { host, model } => run_ollama(host, model, &prompt).await?,
        Provider::None => {
            return Err(AppError::Conflict("no AI provider configured".to_string()))
        }
    };
    Ok(Json(CompleteResp { text: text.trim().to_string() }))
}

async fn run_cli(cmd: &str, prompt: &str) -> ApiResult<String> {
    use tokio::process::Command;
    // `claude -p` (print mode) reads the prompt from stdin and prints the reply.
    let args: Vec<String> = std::env::var("SELFNOTE_AI_ARGS")
        .unwrap_or_else(|_| "-p".to_string())
        .split_whitespace()
        .map(String::from)
        .collect();

    let mut child = Command::new(cmd)
        .args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Other(anyhow::anyhow!("spawn {cmd}: {e}")))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| AppError::Other(anyhow::anyhow!("write stdin: {e}")))?;
        drop(stdin);
    }

    let output = tokio::time::timeout(REQUEST_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| AppError::Conflict("AI request timed out".to_string()))?
        .map_err(|e| AppError::Other(anyhow::anyhow!("cli wait: {e}")))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(anyhow::anyhow!("AI CLI failed: {err}")));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn run_anthropic(model: &str, prompt: &str) -> ApiResult<String> {
    let key = std::env::var("ANTHROPIC_API_KEY")
        .map_err(|_| AppError::Conflict("ANTHROPIC_API_KEY not set".to_string()))?;
    let client = http_client()?;
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 1024,
        "messages": [{ "role": "user", "content": prompt }],
    });
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Other(anyhow::anyhow!("anthropic request: {e}")))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Other(anyhow::anyhow!("anthropic parse: {e}")))?;
    let text = json["content"][0]["text"].as_str().unwrap_or_default().to_string();
    Ok(text)
}

async fn run_ollama(host: &str, model: &str, prompt: &str) -> ApiResult<String> {
    let client = http_client()?;
    let body = serde_json::json!({ "model": model, "prompt": prompt, "stream": false });
    let resp = client
        .post(format!("{host}/api/generate"))
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Other(anyhow::anyhow!("ollama request: {e}")))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Other(anyhow::anyhow!("ollama parse: {e}")))?;
    Ok(json["response"].as_str().unwrap_or_default().to_string())
}

fn http_client() -> ApiResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| AppError::Other(anyhow::anyhow!("http client: {e}")))
}

/* ------------------------------------------------------------------ chat --- */

#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
    /// "user" or "assistant".
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct ChatReq {
    pub doc_id: Option<uuid::Uuid>,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
    /// The note's current text, so the assistant can ground its answers in it.
    pub context: Option<String>,
    /// A passage the user has selected in the editor.
    pub selection: Option<String>,
}

/// If the request references a document, the caller must belong to its workspace
/// — the assistant must not become a way to read notes you can't otherwise see.
async fn authorize_doc(
    state: &AppState,
    user: &AuthUser,
    doc_id: Option<uuid::Uuid>,
) -> ApiResult<()> {
    if let Some(doc_id) = doc_id {
        let ws: Option<(uuid::Uuid,)> =
            sqlx::query_as("select workspace_id from documents where id = $1")
                .bind(doc_id)
                .fetch_optional(&state.pool)
                .await?;
        let workspace_id = ws.ok_or(AppError::NotFound)?.0;
        crate::workspaces::member_role(state, workspace_id, user.id)
            .await?
            .ok_or(AppError::Forbidden)?;
    }
    Ok(())
}

/// The assistant's persona + the note it's grounded in.
fn chat_system(context: Option<&str>, selection: Option<&str>) -> String {
    let mut s = String::from(
        "You are Selfnote's built-in writing assistant, embedded in the sidebar of a \
         collaborative note editor. Help the user think through, draft, and refine the note \
         they're working on. Be warm but concise, and get to the point. When asked to write, \
         continue, or improve text, reply with polished prose the user can drop straight into \
         the note. Format with Markdown.",
    );
    if let Some(ctx) = context.filter(|c| !c.trim().is_empty()) {
        s.push_str("\n\nThe note the user is currently editing:\n\n");
        s.push_str(truncate(ctx));
    }
    if let Some(sel) = selection.filter(|c| !c.trim().is_empty()) {
        s.push_str("\n\nThe user has selected this passage:\n\n");
        s.push_str(truncate(sel));
    }
    s
}

/// Non-streaming chat — one request, one full reply. Used as a fallback by
/// clients that don't consume the SSE stream.
pub async fn chat(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<ChatReq>,
) -> ApiResult<Json<CompleteResp>> {
    authorize_doc(&state, &user, req.doc_id).await?;
    let system = chat_system(req.context.as_deref(), req.selection.as_deref());
    let text = match provider() {
        Provider::ClaudeCli { cmd, .. } => run_cli(cmd, &flatten_chat(&system, &req.messages)).await?,
        Provider::AnthropicApi { model } => anthropic_chat(model, &system, &req.messages, None).await?,
        Provider::Ollama { host, model } => {
            ollama_chat(host, model, &system, &req.messages, None).await?
        }
        Provider::None => {
            return Err(AppError::Conflict("no AI provider configured".to_string()))
        }
    };
    Ok(Json(CompleteResp { text: text.trim().to_string() }))
}

/// Streaming chat over Server-Sent Events. Emits `data: {"delta":"…"}` events as
/// text is produced, a final `event: done`, or `event: error` on failure.
pub async fn chat_stream(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<ChatReq>,
) -> ApiResult<Sse<ReceiverStream<Result<Event, Infallible>>>> {
    authorize_doc(&state, &user, req.doc_id).await?;
    let provider = provider().clone();
    let system = chat_system(req.context.as_deref(), req.selection.as_deref());
    let messages = req.messages.clone();

    let (sse_tx, sse_rx) = mpsc::channel::<Result<Event, Infallible>>(64);
    tokio::spawn(async move {
        // Producer sends raw text deltas on `dtx`; a forwarder wraps each into an
        // SSE event so the provider code stays transport-agnostic.
        let (dtx, mut drx) = mpsc::channel::<String>(64);
        let sse_fwd = sse_tx.clone();
        let fwd = tokio::spawn(async move {
            while let Some(chunk) = drx.recv().await {
                let ev = Event::default()
                    .json_data(serde_json::json!({ "delta": chunk }))
                    .unwrap_or_else(|_| Event::default());
                if sse_fwd.send(Ok(ev)).await.is_err() {
                    break;
                }
            }
        });

        let res = run_provider_stream(&provider, &system, &messages, &dtx).await;
        drop(dtx);
        let _ = fwd.await;

        let ev = match res {
            Ok(()) => Event::default().event("done").data("{}"),
            Err(e) => Event::default()
                .event("error")
                .json_data(serde_json::json!({ "error": e.to_string() }))
                .unwrap_or_else(|_| Event::default().event("error").data("{}")),
        };
        let _ = sse_tx.send(Ok(ev)).await;
    });

    Ok(Sse::new(ReceiverStream::new(sse_rx)).keep_alive(KeepAlive::default()))
}

async fn run_provider_stream(
    provider: &Provider,
    system: &str,
    messages: &[ChatMessage],
    tx: &mpsc::Sender<String>,
) -> ApiResult<()> {
    match provider {
        // The `claude -p` CLI returns the whole reply at once, and stream-json
        // parsing is fragile across CLI versions — so we run it to completion and
        // re-emit the text word-by-word for the same progressive typing feel.
        Provider::ClaudeCli { cmd, .. } => {
            let text = run_cli(cmd, &flatten_chat(system, messages)).await?;
            for word in chunk_words(text.trim()) {
                if tx.send(word).await.is_err() {
                    break;
                }
            }
            Ok(())
        }
        Provider::AnthropicApi { model } => {
            anthropic_chat(model, system, messages, Some(tx)).await.map(|_| ())
        }
        Provider::Ollama { host, model } => {
            ollama_chat(host, model, system, messages, Some(tx)).await.map(|_| ())
        }
        Provider::None => Err(AppError::Conflict("no AI provider configured".to_string())),
    }
}

/// Flatten a conversation into a single prompt for the CLI provider.
fn flatten_chat(system: &str, messages: &[ChatMessage]) -> String {
    let mut p = String::from(system);
    p.push_str("\n\n");
    for m in messages {
        let who = if m.role == "assistant" { "Assistant" } else { "User" };
        p.push_str(who);
        p.push_str(": ");
        p.push_str(&m.content);
        p.push('\n');
    }
    p.push_str("Assistant:");
    p
}

/// Split text into word-sized chunks (keeping trailing whitespace) for a typing
/// effect when the underlying provider can't stream.
fn chunk_words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in text.chars() {
        cur.push(ch);
        if ch == ' ' || ch == '\n' {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn chat_messages_json(messages: &[ChatMessage]) -> Vec<serde_json::Value> {
    messages
        .iter()
        .map(|m| {
            let role = if m.role == "assistant" { "assistant" } else { "user" };
            serde_json::json!({ "role": role, "content": m.content })
        })
        .collect()
}

/// Anthropic Messages API. With `tx`, streams `content_block_delta` text as it
/// arrives; without, returns the full reply.
async fn anthropic_chat(
    model: &str,
    system: &str,
    messages: &[ChatMessage],
    tx: Option<&mpsc::Sender<String>>,
) -> ApiResult<String> {
    let key = std::env::var("ANTHROPIC_API_KEY")
        .map_err(|_| AppError::Conflict("ANTHROPIC_API_KEY not set".to_string()))?;
    let client = http_client()?;
    let streaming = tx.is_some();
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 1024,
        "system": system,
        "stream": streaming,
        "messages": chat_messages_json(messages),
    });
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Other(anyhow::anyhow!("anthropic request: {e}")))?;

    if !streaming {
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Other(anyhow::anyhow!("anthropic parse: {e}")))?;
        return Ok(json["content"][0]["text"].as_str().unwrap_or_default().to_string());
    }

    let tx = tx.unwrap();
    let mut acc = String::new();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(item) = stream.next().await {
        let bytes = item.map_err(|e| AppError::Other(anyhow::anyhow!("anthropic stream: {e}")))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(idx) = buf.find('\n') {
            let line: String = buf.drain(..=idx).collect();
            let line = line.trim();
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                    if json["type"] == "content_block_delta" {
                        if let Some(t) = json["delta"]["text"].as_str() {
                            acc.push_str(t);
                            let _ = tx.send(t.to_string()).await;
                        }
                    }
                }
            }
        }
    }
    Ok(acc)
}

/// Ollama chat API. With `tx`, streams NDJSON `message.content` chunks; without,
/// returns the full reply.
async fn ollama_chat(
    host: &str,
    model: &str,
    system: &str,
    messages: &[ChatMessage],
    tx: Option<&mpsc::Sender<String>>,
) -> ApiResult<String> {
    let client = http_client()?;
    let streaming = tx.is_some();
    let mut msgs = vec![serde_json::json!({ "role": "system", "content": system })];
    msgs.extend(chat_messages_json(messages));
    let body = serde_json::json!({ "model": model, "messages": msgs, "stream": streaming });
    let resp = client
        .post(format!("{host}/api/chat"))
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Other(anyhow::anyhow!("ollama request: {e}")))?;

    if !streaming {
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Other(anyhow::anyhow!("ollama parse: {e}")))?;
        return Ok(json["message"]["content"].as_str().unwrap_or_default().to_string());
    }

    let tx = tx.unwrap();
    let mut acc = String::new();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(item) = stream.next().await {
        let bytes = item.map_err(|e| AppError::Other(anyhow::anyhow!("ollama stream: {e}")))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(idx) = buf.find('\n') {
            let line: String = buf.drain(..=idx).collect();
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(t) = json["message"]["content"].as_str() {
                    if !t.is_empty() {
                        acc.push_str(t);
                        let _ = tx.send(t.to_string()).await;
                    }
                }
            }
        }
    }
    Ok(acc)
}
