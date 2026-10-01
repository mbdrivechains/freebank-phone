//! `POST /feedback`: "Send to FreeBank", for people without a GitHub account. A report is a small JSON
//! object from the desktop app or the phone page. It is checked, then written as one file in the reports
//! folder (`--feedback-dir`), readable only by the relay's user. The FreeBank team triages the reports into
//! GitHub issues without personal details.
//!
//! What is kept: the report's own fields and the minute it arrived. Never an address: nginx passes none on
//! and limits each address itself (`deploy/nginx-app.ecxfreebank.com.conf`); the relay has no per-address
//! logic. The relay's own limits: a 16 KiB body, a global rate (a burst of 20, then one every 6 s), and at
//! most 1000 reports waiting in the folder. Without `--feedback-dir` there is no such route.
//!
//! Text is refused if it holds control characters other than new lines and tabs, so a report can't
//! rewrite the terminal of whoever reads it, or invisible characters (bidirectional formatting,
//! zero-width, tags, blank fillers, private use), so it can't carry text a person doesn't see but a
//! program reading it does. Report text is data, never instructions: it is read escaped.

use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};

/// The largest request body.
pub const MAX_BODY: usize = 16 * 1024;
/// The longest report text, in characters.
pub const MAX_TEXT: usize = 8000;
/// Reports waiting in the folder; past it, new ones are turned away until some are read and removed.
pub const MAX_WAITING: usize = 1000;
/// The global rate: a burst of this many, then one every `REFILL_SECS`: several times one address's
/// own allowance at nginx (a burst of 5, then one a minute), so one address can't use it all up.
const BURST: f64 = 20.0;
const REFILL_SECS: f64 = 6.0;
/// Recent reports remembered (as hashes) so an exact repeat is refused.
const RECENT: usize = 1000;

/// A report as sent. Unknown fields are refused.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    /// "problem", "idea" or "security".
    pub kind: String,
    pub text: String,
    /// How to reach the sender, if they want a reply. Optional.
    #[serde(default)]
    pub contact: String,
    /// Sent by the app with the sender's agreement: its version, the system, the node's version.
    #[serde(default)]
    pub app: String,
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub node: String,
    /// "app" or "phone".
    pub from: String,
}

/// What is written: the report and the minute it arrived.
#[derive(Serialize)]
struct Stored<'a> {
    v: u8,
    received: String,
    from: &'a str,
    kind: &'a str,
    text: &'a str,
    contact: &'a str,
    app: &'a str,
    os: &'a str,
    node: &'a str,
}

pub struct Desk {
    dir: PathBuf,
    origins: Vec<String>,
    bucket: Mutex<(f64, Instant)>,
    /// SHA-256 of each recent report's kind and text, oldest first.
    recent: Mutex<std::collections::VecDeque<[u8; 32]>>,
}

/// The route, when a reports folder is configured (made beforehand with `prepare`).
pub fn routes(dir: PathBuf, origins: Vec<String>) -> Router {
    let desk = Arc::new(Desk { dir, origins, bucket: Mutex::new((BURST, Instant::now())), recent: Mutex::default() });
    Router::new()
        .route("/feedback", post(take))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(desk)
}

/// Make the reports folder if it is missing, readable only by the relay's user.
pub fn prepare(dir: &Path) -> std::io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(dir)
}

fn answer(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

/// Characters that hide text from a person while a program reading it still sees it: bidirectional
/// formatting, zero-width and other format characters, blank fillers, variation selectors, tags,
/// private use, and line and paragraph separators. (The desktop drops most of them from device names.)
pub fn invisible(c: char) -> bool {
    matches!(c,
        '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
        | '\u{00AD}' | '\u{034F}' | '\u{115F}' | '\u{1160}' | '\u{17B4}' | '\u{17B5}' | '\u{180B}'..='\u{180F}'
        | '\u{200B}'..='\u{200D}' | '\u{2060}'..='\u{2065}' | '\u{206A}'..='\u{206F}' | '\u{2028}' | '\u{2029}'
        | '\u{3164}' | '\u{E000}'..='\u{F8FF}' | '\u{FE00}'..='\u{FE0F}' | '\u{FEFF}' | '\u{FFA0}' | '\u{FFF9}'..='\u{FFFB}'
        | '\u{1D173}'..='\u{1D17A}' | '\u{E0000}'..='\u{EFFFF}' | '\u{F0000}'..='\u{10FFFF}')
}

/// Refused characters: controls other than new line and tab (C0, DEL, C1, where a terminal reads
/// escapes), and invisible ones.
fn bad_char(c: char, multiline: bool) -> bool {
    (c.is_control() && !(multiline && (c == '\n' || c == '\t'))) || invisible(c)
}

/// A field that is `max` characters or fewer, with none of the refused characters.
fn field_ok(s: &str, max: usize, multiline: bool) -> bool {
    s.chars().count() <= max && !s.chars().any(|c| bad_char(c, multiline))
}

/// Why a report is refused, or None.
pub fn problem(r: &Report) -> Option<&'static str> {
    if !matches!(r.kind.as_str(), "problem" | "idea" | "security") {
        return Some("kind is problem, idea or security");
    }
    if !matches!(r.from.as_str(), "app" | "phone") {
        return Some("from is app or phone");
    }
    if r.text.trim().is_empty() {
        return Some("the report is empty");
    }
    if !field_ok(&r.text, MAX_TEXT, true) {
        return Some("the text is too long, or holds control characters");
    }
    let short = [(&r.contact, 200), (&r.app, 40), (&r.os, 80), (&r.node, 40)];
    if short.iter().any(|(s, max)| !field_ok(s, *max, false)) {
        return Some("a detail is too long, or holds control characters");
    }
    None
}

/// Not an exact repeat of a recent report (its kind and text). Remembers it.
fn first_time(desk: &Desk, r: &Report) -> bool {
    use sha2::{Digest, Sha256};
    let h: [u8; 32] = Sha256::new().chain_update(r.kind.as_bytes()).chain_update([0]).chain_update(r.text.trim().as_bytes()).finalize().into();
    let mut recent = desk.recent.lock().unwrap_or_else(|e| e.into_inner());
    if recent.contains(&h) {
        return false;
    }
    if recent.len() >= RECENT {
        recent.pop_front();
    }
    recent.push_back(h);
    true
}

/// Take one token from the global bucket.
fn admit(desk: &Desk) -> bool {
    let mut b = desk.bucket.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    b.0 = (b.0 + now.duration_since(b.1).as_secs_f64() / REFILL_SECS).min(BURST);
    b.1 = now;
    if b.0 >= 1.0 {
        b.0 -= 1.0;
        true
    } else {
        false
    }
}

/// "2026-09-30T11:52Z" for a unix time (UTC, to the minute).
fn minute(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let (h, m) = ((secs % 86_400) / 3600, (secs % 3600) / 60);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(mo <= 2);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}Z")
}

/// Write the report as `<unix time>-<id>.json`, owner-only. Returns the id.
fn store(dir: &Path, r: &Report) -> std::io::Result<String> {
    let waiting = std::fs::read_dir(dir)?.filter(|e| e.is_ok()).count();
    if waiting >= MAX_WAITING {
        return Err(std::io::Error::other("full"));
    }
    let mut raw = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut raw);
    let id: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let body = serde_json::to_vec_pretty(&Stored {
        v: 1,
        received: minute(secs),
        from: &r.from,
        kind: &r.kind,
        text: &r.text,
        contact: &r.contact,
        app: &r.app,
        os: &r.os,
        node: &r.node,
    })?;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let mut f = o.open(dir.join(format!("{secs}-{id}.json")))?;
    f.write_all(&body)?;
    f.sync_all()?;
    Ok(id)
}

async fn take(State(desk): State<Arc<Desk>>, headers: HeaderMap, body: Result<Json<Report>, JsonRejection>) -> Response {
    // Other websites can't post through their visitors' browsers (the app sends no Origin).
    if !crate::origin_allowed(&desk.origins, headers.get(header::ORIGIN)) {
        return answer(StatusCode::FORBIDDEN, "not from this site");
    }
    let Json(report) = match body {
        Ok(r) => r,
        Err(JsonRejection::MissingJsonContentType(_)) => {
            return answer(StatusCode::UNSUPPORTED_MEDIA_TYPE, "send application/json")
        }
        Err(e) if e.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            return answer(StatusCode::PAYLOAD_TOO_LARGE, "the report is too big")
        }
        Err(_) => return answer(StatusCode::BAD_REQUEST, "not a report"),
    };
    if let Some(why) = problem(&report) {
        return answer(StatusCode::BAD_REQUEST, why);
    }
    if !first_time(&desk, &report) {
        return answer(StatusCode::CONFLICT, "FreeBank already has this report");
    }
    if !admit(&desk) {
        return answer(StatusCode::TOO_MANY_REQUESTS, "too many reports just now; try again in a few minutes");
    }
    let dir = desk.dir.clone();
    match tokio::task::spawn_blocking(move || store(&dir, &report)).await {
        Ok(Ok(id)) => {
            tracing::info!("feedback report stored");
            (StatusCode::CREATED, Json(serde_json::json!({ "id": id }))).into_response()
        }
        Ok(Err(e)) if e.to_string() == "full" => {
            answer(StatusCode::SERVICE_UNAVAILABLE, "FreeBank isn't taking reports just now; try GitHub")
        }
        _ => answer(StatusCode::INTERNAL_SERVER_ERROR, "the report couldn't be saved"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minutes_in_utc() {
        assert_eq!(minute(0), "1970-01-01T00:00Z");
        assert_eq!(minute(1_790_000_000), "2026-09-21T14:13Z");
        assert_eq!(minute(951_782_400), "2000-02-29T00:00Z");
    }

    fn report(text: &str) -> Report {
        Report {
            kind: "problem".into(),
            text: text.into(),
            contact: String::new(),
            app: "0.2.1".into(),
            os: "macOS 26 (arm64)".into(),
            node: "v0.2.17".into(),
            from: "app".into(),
        }
    }

    #[test]
    fn reports_are_checked() {
        assert_eq!(problem(&report("Setup stopped at the download.\n\tTwice.")), None);
        assert!(problem(&report("  ")).is_some());
        assert!(problem(&report(&"x".repeat(MAX_TEXT + 1))).is_some());
        assert_eq!(problem(&report(&"é".repeat(MAX_TEXT))), None);
        // Terminal escapes, C1 controls and bidi overrides are refused, and so is invisible text: tags,
        // zero-width characters, direction marks, fillers, private use.
        for bad in [
            "\u{1b}[2J", "a\u{9b}31m", "\u{202e}txt.exe", "a\u{0}b", "\r", "ok\u{E0049}\u{E0067}", "a\u{200B}b",
            "a\u{200E}b", "a\u{2060}b", "a\u{FEFF}b", "a\u{3164}b", "a\u{E000}b", "a\u{2028}b", "a\u{FE0F}b",
        ] {
            assert!(problem(&report(bad)).is_some(), "{bad:?}");
        }
        // Ordinary text in any script, emoji without joiners, and tabs and new lines pass.
        assert_eq!(problem(&report("Привет, 你好, مرحبا, नमस्ते 🙂\n\tok")), None);
        let mut r = report("ok");
        r.contact = "me\nyou".into();
        assert!(problem(&r).is_some());
        let mut r = report("ok");
        r.kind = "spam".into();
        assert!(problem(&r).is_some());
    }

    /// The route through the whole router: stored owner-only, and refused from other sites, as the wrong
    /// type, or too big.
    #[tokio::test]
    async fn posted_reports_are_kept_privately() {
        use axum::body::Body;
        use tower::ServiceExt;
        let dir = std::env::temp_dir().join(format!("fbfeedback-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        prepare(&dir).unwrap();
        let cfg = crate::Config {
            feedback_dir: Some(dir.clone()),
            origins: vec!["https://app.ecxfreebank.com".into()],
            ..Default::default()
        };
        let post = |origin: Option<&str>, ctype: &str, body: String| {
            let mut b = axum::http::Request::post("/feedback").header(header::CONTENT_TYPE, ctype);
            if let Some(o) = origin {
                b = b.header(header::ORIGIN, o);
            }
            crate::router(cfg.clone()).oneshot(b.body(Body::from(body)).unwrap())
        };
        let ok = r#"{"kind":"idea","text":"A dark QR code?","from":"phone"}"#.to_string();
        let res = post(Some("https://app.ecxfreebank.com"), "application/json", ok.clone()).await.unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);
        let res = post(None, "application/json", ok.clone()).await.unwrap(); // the desktop app
        assert_eq!(res.status(), StatusCode::CREATED);
        let files: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).collect();
        assert_eq!(files.len(), 2);
        let kept: serde_json::Value = serde_json::from_slice(&std::fs::read(&files[0]).unwrap()).unwrap();
        assert_eq!((kept["kind"].as_str(), kept["text"].as_str()), (Some("idea"), Some("A dark QR code?")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&files[0]).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let res = post(Some("https://evil.example"), "application/json", ok.clone()).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let res = post(None, "text/plain", ok).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        let big = format!(r#"{{"kind":"idea","text":"{}","from":"app"}}"#, "x".repeat(MAX_BODY));
        let res = post(None, "application/json", big).await.unwrap();
        assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let res = post(None, "application/json", r#"{"kind":"idea","text":"x","from":"app","ip":"1.2.3.4"}"#.into()).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_bucket_runs_dry_and_repeats_are_refused() {
        let desk = Desk { dir: PathBuf::new(), origins: vec![], bucket: Mutex::new((BURST, Instant::now())), recent: Mutex::default() };
        let taken = (0..30).filter(|_| admit(&desk)).count();
        assert_eq!(taken, BURST as usize);
        assert!(first_time(&desk, &report("The same again")));
        assert!(!first_time(&desk, &report("The same again  ")));
        assert!(first_time(&desk, &report("Something else")));
    }
}
