// A single, reusable retry policy for the backend's network calls.
//
// Before this module, retry logic was scattered and inconsistent: the REST path
// only recovered from 401s (retry-once), the trouter had its own reconnection
// loop, and everything else failed on the first hiccup. This centralizes the
// decision "should this error be retried, and how" into one tested place.
//
// The design separates two concerns:
//   1. CLASSIFY the error (what KIND of failure is this?)
//   2. APPLY a policy based on the class (auth -> refresh+retry, transient ->
//      back off + retry, permanent -> give up immediately).
//
// The auth-refresh action is injected by the caller (a hook), so this module
// stays free of any knowledge of HOW credentials are minted — that belongs to
// whoever owns the token cache / session.

use std::time::Duration;

/// How a failed network operation should be treated by the retry policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    /// The credential was rejected (HTTP 401). Refresh it, then retry.
    Auth,
    /// A temporary failure (timeout, dropped connection, 429/502/503/504).
    /// Retrying after a short back-off is likely to succeed.
    Transient,
    /// A definitive failure (400/403/404, parse errors, logic bugs). Retrying
    /// would only waste time and hide the real problem — give up now.
    Permanent,
}

/// Classify an error from the network layer. We match on the rendered error
/// chain because the modules bail with `"... -> {status}"` strings (and reqwest
/// timeout/connect errors carry recognizable text). This keeps classification
/// working without threading a typed error through every call site.
pub fn classify(err: &anyhow::Error) -> ErrorClass {
    // Join the whole chain once, lowercased, so we catch the signal wherever it
    // sits (top-level context or the underlying cause).
    let text = err
        .chain()
        .map(|c| c.to_string())
        .collect::<Vec<_>>()
        .join(" | ")
        .to_lowercase();

    // Auth first: a 401 is always an auth problem, never "transient".
    if text.contains("401") || text.contains("unauthorized") {
        return ErrorClass::Auth;
    }

    // Transient: server-side blips and connection-level failures.
    const TRANSIENT_SIGNALS: &[&str] = &[
        "429", // too many requests (rate limited)
        "500", // internal server error
        "502", // bad gateway
        "503", // service unavailable
        "504", // gateway timeout
        "timed out",
        "timeout",
        "connection reset",
        "connection refused",
        "connection closed",
        "broken pipe",
        "dns error",
        "tls",
    ];
    if TRANSIENT_SIGNALS.iter().any(|s| text.contains(s)) {
        return ErrorClass::Transient;
    }

    // Everything else (400/403/404, parse failures, bad params, unknown method):
    // retrying will not help.
    ErrorClass::Permanent
}

/// The retry budget and back-off shape. `base_delay` is doubled after each
/// transient failure, capped at `max_delay`.
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    /// Total number of attempts, including the first. Must be >= 1.
    pub max_attempts: u32,
    /// Delay before the first retry after a transient failure.
    pub base_delay: Duration,
    /// Upper bound for the exponential back-off.
    pub max_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay: Duration::from_millis(300),
            max_delay: Duration::from_secs(5),
        }
    }
}

impl RetryPolicy {
    /// A minimal policy that runs the operation exactly once (no retries). Useful
    /// where retrying is undesirable but the classification hook is still wanted.
    pub fn once() -> Self {
        Self { max_attempts: 1, ..Self::default() }
    }
}

/// Run an async network operation under a retry policy.
///
/// - `op` is the operation to run; it is called once per attempt.
/// - `on_auth` is an optional hook invoked when an attempt fails with an
///   [`ErrorClass::Auth`] error, BEFORE the retry, so the caller can refresh
///   credentials. It runs at most once per `with_retry` call (an auth error that
///   survives a refresh is treated as permanent — refreshing again won't help).
/// - Transient failures back off exponentially between attempts.
/// - Permanent failures return immediately.
///
/// Returns the first success, or the last error once the attempt budget is spent.
pub async fn with_retry<T, Op, OpFut, Auth, AuthFut>(
    policy: RetryPolicy,
    mut on_auth: Option<Auth>,
    op: Op,
) -> anyhow::Result<T>
where
    Op: Fn() -> OpFut,
    OpFut: std::future::Future<Output = anyhow::Result<T>>,
    Auth: FnMut() -> AuthFut,
    AuthFut: std::future::Future<Output = anyhow::Result<()>>,
{
    let attempts = policy.max_attempts.max(1);
    let mut delay = policy.base_delay;
    let mut auth_refreshed = false;

    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 0..attempts {
        let is_last = attempt + 1 == attempts;
        match op().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                match classify(&e) {
                    ErrorClass::Permanent => return Err(e),
                    ErrorClass::Auth => {
                        // Refresh once; if that already happened, a further 401
                        // is not something a retry can fix.
                        if is_last || auth_refreshed {
                            return Err(e);
                        }
                        if let Some(hook) = on_auth.as_mut() {
                            if let Err(refresh_err) = hook().await {
                                // couldn't refresh -> surface the original error
                                let _ = refresh_err;
                                return Err(e);
                            }
                            auth_refreshed = true;
                        } else {
                            // no way to refresh -> retrying is pointless
                            return Err(e);
                        }
                        // retry immediately with fresh credentials (no back-off)
                        last_err = Some(e);
                    }
                    ErrorClass::Transient => {
                        if is_last {
                            return Err(e);
                        }
                        last_err = Some(e);
                        tokio::time::sleep(delay).await;
                        delay = (delay * 2).min(policy.max_delay);
                    }
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("retry budget exhausted")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    fn err(msg: &str) -> anyhow::Error {
        anyhow::anyhow!(msg.to_string())
    }

    #[test]
    fn classify_recognizes_auth() {
        assert_eq!(classify(&err("CSA users/me -> 401 Unauthorized")), ErrorClass::Auth);
        assert_eq!(classify(&err("send -> 401 Unauthorized: ...")), ErrorClass::Auth);
    }

    #[test]
    fn classify_recognizes_transient() {
        assert_eq!(classify(&err("chatService messages -> 503 Service Unavailable")), ErrorClass::Transient);
        assert_eq!(classify(&err("error sending request: operation timed out")), ErrorClass::Transient);
        assert_eq!(classify(&err("connection reset by peer")), ErrorClass::Transient);
        assert_eq!(classify(&err("-> 429 Too Many Requests")), ErrorClass::Transient);
    }

    #[test]
    fn classify_defaults_to_permanent() {
        assert_eq!(classify(&err("fetchShortProfile -> 404 Not Found")), ErrorClass::Permanent);
        assert_eq!(classify(&err("missing param: conversation")), ErrorClass::Permanent);
        assert_eq!(classify(&err("-> 400 Bad Request")), ErrorClass::Permanent);
    }

    #[test]
    fn classify_looks_through_the_whole_chain() {
        let e = err("network layer").context("chatService messages -> 503");
        assert_eq!(classify(&e), ErrorClass::Transient);
    }

    // A no-op auth hook for tests that don't exercise the auth path.
    fn no_auth() -> Option<fn() -> std::future::Ready<anyhow::Result<()>>> {
        None
    }

    #[tokio::test]
    async fn succeeds_first_try_without_retrying() {
        let calls = Arc::new(AtomicU32::new(0));
        let c = calls.clone();
        let out: anyhow::Result<u32> = with_retry(RetryPolicy::default(), no_auth(), || {
            let c = c.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                Ok(42u32)
            }
        })
        .await;
        assert_eq!(out.unwrap(), 42);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "must not retry on success");
    }

    #[tokio::test]
    async fn permanent_error_is_not_retried() {
        let calls = Arc::new(AtomicU32::new(0));
        let c = calls.clone();
        let out: anyhow::Result<u32> = with_retry(RetryPolicy::default(), no_auth(), || {
            let c = c.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                Err(err("-> 404 Not Found"))
            }
        })
        .await;
        assert!(out.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1, "permanent errors must fail fast");
    }

    #[tokio::test]
    async fn transient_error_retries_then_succeeds() {
        let calls = Arc::new(AtomicU32::new(0));
        let c = calls.clone();
        // fail transiently twice, succeed on the third attempt
        let policy = RetryPolicy {
            max_attempts: 3,
            base_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(2),
        };
        let out: anyhow::Result<u32> = with_retry(policy, no_auth(), || {
            let c = c.clone();
            async move {
                let n = c.fetch_add(1, Ordering::SeqCst);
                if n < 2 { Err(err("-> 503 Service Unavailable")) } else { Ok(7u32) }
            }
        })
        .await;
        assert_eq!(out.unwrap(), 7);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn transient_error_gives_up_after_budget() {
        let calls = Arc::new(AtomicU32::new(0));
        let c = calls.clone();
        let policy = RetryPolicy {
            max_attempts: 2,
            base_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(2),
        };
        let out: anyhow::Result<u32> = with_retry(policy, no_auth(), || {
            let c = c.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                Err(err("-> 503 Service Unavailable"))
            }
        })
        .await;
        assert!(out.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 2, "must stop at max_attempts");
    }

    #[tokio::test]
    async fn auth_error_refreshes_once_then_retries() {
        let calls = Arc::new(AtomicU32::new(0));
        let refreshes = Arc::new(AtomicU32::new(0));
        let c = calls.clone();
        let r = refreshes.clone();
        let out: anyhow::Result<u32> = with_retry(
            RetryPolicy::default(),
            Some(|| {
                let r = r.clone();
                async move {
                    r.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            }),
            || {
                let c = c.clone();
                async move {
                    let n = c.fetch_add(1, Ordering::SeqCst);
                    // 401 on the first attempt, success after the refresh
                    if n == 0 { Err(err("-> 401 Unauthorized")) } else { Ok(1u32) }
                }
            },
        )
        .await;
        assert_eq!(out.unwrap(), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 2, "one retry after refresh");
        assert_eq!(refreshes.load(Ordering::SeqCst), 1, "refresh exactly once");
    }

    #[tokio::test]
    async fn persistent_auth_error_refreshes_only_once() {
        let calls = Arc::new(AtomicU32::new(0));
        let refreshes = Arc::new(AtomicU32::new(0));
        let c = calls.clone();
        let r = refreshes.clone();
        // always 401, even after refresh -> must not loop refreshing forever
        let out: anyhow::Result<u32> = with_retry(
            RetryPolicy { max_attempts: 5, ..RetryPolicy::default() },
            Some(|| {
                let r = r.clone();
                async move {
                    r.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            }),
            || {
                let c = c.clone();
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    Err::<u32, _>(err("-> 401 Unauthorized"))
                }
            },
        )
        .await;
        assert!(out.is_err());
        assert_eq!(refreshes.load(Ordering::SeqCst), 1, "refresh must not repeat");
        assert_eq!(calls.load(Ordering::SeqCst), 2, "one attempt, one refreshed retry");
    }
}
