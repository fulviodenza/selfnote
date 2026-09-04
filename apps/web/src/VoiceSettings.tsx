/**
 * "My writing voice" card (Connections settings). A textarea backed by
 * GET/PUT /ai/voice holding 1-3 paragraphs of the user's own writing; it
 * powers the "Rewrite in my voice" note action. Empty clears the profile
 * (falls back to a generic rewrite). The server caps the sample at 8000 chars.
 * Only rendered when the server reports an AI provider.
 */
import { useEffect, useState } from "react";
import { api } from "./api";

/** Matches the server-side cap so we don't send more than will be stored. */
const MAX_SAMPLE = 8000;

export function VoiceSettingsCard() {
  const [sample, setSample] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<string>("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getVoice()
      .then((v) => {
        if (!alive) return;
        setSample(v.sample);
        setSaved(v.sample);
        setUpdatedAt(v.updated_at);
      })
      .catch(() => undefined)
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const dirty = sample !== saved;

  const save = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    setOk(false);
    try {
      const v = await api.setVoice(sample.slice(0, MAX_SAMPLE));
      setSample(v.sample);
      setSaved(v.sample);
      setUpdatedAt(v.updated_at);
      setOk(true);
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 160) : "Could not save your voice sample.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="conn-list">
      <div className="conn-list-title">My writing voice</div>
      <p className="conn-intro" style={{ margin: "0 0 12px" }}>
        Paste 1–3 paragraphs of your own writing. It grounds the “Rewrite in my voice” note action
        so rewrites sound like you. Leave it empty for a generic clarity rewrite.
      </p>
      {!loaded ? (
        <div className="conn-muted">Loading…</div>
      ) : (
        <>
          <textarea
            className="voice-sample"
            value={sample}
            maxLength={MAX_SAMPLE}
            rows={6}
            placeholder="A few paragraphs in your natural voice…"
            onChange={(e) => {
              setSample(e.target.value);
              setOk(false);
            }}
          />
          <div className="voice-foot">
            <span className="conn-row-meta">
              {sample.length}/{MAX_SAMPLE}
              {updatedAt ? ` · saved ${new Date(updatedAt).toLocaleDateString()}` : ""}
              {ok ? " · updated" : ""}
            </span>
            <button className="voice-save" onClick={save} disabled={busy || !dirty}>
              {busy ? "Saving…" : "Save voice"}
            </button>
          </div>
          {error ? <div className="conn-error">{error}</div> : null}
        </>
      )}
    </div>
  );
}
