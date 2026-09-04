//! AI backend detection + completion.
//!
//! Server-owned: the mobile/web client only surfaces "Assist" when `/ai/status`
//! reports a provider, so a plain instance shows no dead buttons. Detection is
//! cheap and cached for the process lifetime. Provider resolution order:
//!   1. a local `claude` (or `$SELFNOTE_AI_CMD`) binary on PATH — data stays on
//!      the server;
//!   2. `$ANTHROPIC_API_KEY` — the Claude API;
//!   3. `$OLLAMA_HOST` — a local open-weights model.
//! Configure the model with `$SELFNOTE_AI_MODEL`.

use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

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

    let cmd = std::env::var("SELFNOTE_AI_CMD").unwrap_or_else(|_| "claude".to_string());
    if binary_on_path(&cmd) {
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
