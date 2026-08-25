use std::sync::OnceLock;

use ironclaw_common::{ReasoningDetail, ReasoningDetails};

use crate::LeakDetector;

pub const PROVIDER_TOOL_NAME_MAX_BYTES: usize = 64;
/// Max serialized size of a single provider tool call's JSON arguments.
///
/// This is a bound on *model output*, not a provider request limit, so raising
/// it cannot cause provider-side rejection. 64 KiB covers legitimate large tool
/// calls (writing an analyzed CSV/report, a multi-hunk `apply_patch`) that the
/// previous 16 KiB cap rejected, which left the model unable to comply and
/// retrying the same call into a give-up loop. It stays bounded — aligned with
/// the 64 KiB checkpoint-state budget and far below the 4 MiB capability-I/O
/// staging cap — and the per-string leak scan and depth guard below are
/// unchanged. See nearai/benchmarks pinchbench failure taxonomy (bucket B).
pub const PROVIDER_ARGUMENTS_MAX_BYTES: usize = 64 * 1024;
/// Max size of model-emitted metadata text (reasoning / response reasoning /
/// signature). Raised from 4 KiB, which truncated legitimate reasoning on
/// analysis-heavy tasks and forced retries (taxonomy bucket C). Same rationale
/// as `PROVIDER_ARGUMENTS_MAX_BYTES`: it bounds model output, not a request.
pub const PROVIDER_METADATA_TEXT_MAX_BYTES: usize = 16 * 1024;
/// Maximum ordered artifacts in one typed provider reasoning payload.
///
/// Provider responses normally emit only a handful of reasoning blocks. A cap
/// of 64 preserves long interleaved traces while bounding per-item validation
/// work and preventing an unbounded vector of empty artifacts.
pub const PROVIDER_REASONING_DETAILS_MAX_ITEMS: usize = 64;
/// Maximum combined content bytes across one typed reasoning payload.
///
/// Each individual content field remains capped at 16 KiB. The aggregate uses
/// the same 64 KiB budget as provider arguments and checkpoint state, allowing
/// several legitimate reasoning artifacts without tying validity to JSON tag,
/// key, or escaping overhead.
pub const PROVIDER_REASONING_DETAILS_MAX_CONTENT_BYTES: usize = 64 * 1024;
/// Provider-supplied reasoning IDs and per-block signatures are replay tokens,
/// not free-form model content, so keep them at the existing 4 KiB bound.
pub const PROVIDER_REASONING_REFERENCE_MAX_BYTES: usize = 4 * 1024;
const PROVIDER_ARGUMENTS_MAX_DEPTH: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ProviderValidationError {
    message: String,
}

impl ProviderValidationError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

pub fn validate_provider_tool_name(value: &str) -> Result<(), ProviderValidationError> {
    if value.is_empty() {
        return Err(ProviderValidationError::new(
            "provider tool name must not be empty",
        ));
    }
    if value.len() > PROVIDER_TOOL_NAME_MAX_BYTES {
        return Err(ProviderValidationError::new(format!(
            "provider tool name exceeds {PROVIDER_TOOL_NAME_MAX_BYTES} bytes"
        )));
    }
    if !value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err(ProviderValidationError::new(
            "provider tool name must contain only ASCII letters, digits, _, or -",
        ));
    }
    Ok(())
}

pub fn validate_provider_identity(
    value: &str,
    label: &str,
    max_len: usize,
) -> Result<(), ProviderValidationError> {
    if value.trim().is_empty() {
        return Err(ProviderValidationError::new(format!(
            "{label} must not be empty"
        )));
    }
    if value.len() > max_len {
        return Err(ProviderValidationError::new(format!(
            "{label} exceeds {max_len} bytes"
        )));
    }
    if value
        .chars()
        .any(|character| character == '\0' || character.is_control())
    {
        return Err(ProviderValidationError::new(format!(
            "{label} must not contain NUL/control characters"
        )));
    }
    Ok(())
}

pub fn validate_provider_token(
    value: &str,
    label: &str,
    max_len: usize,
) -> Result<(), ProviderValidationError> {
    if value.is_empty() {
        return Err(ProviderValidationError::new(format!(
            "{label} must not be empty"
        )));
    }
    if value.len() > max_len {
        return Err(ProviderValidationError::new(format!(
            "{label} exceeds {max_len} bytes"
        )));
    }
    if !value.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | ':')
    }) {
        return Err(ProviderValidationError::new(format!(
            "{label} must contain only ASCII letters, digits, _, -, ., or :"
        )));
    }
    Ok(())
}

pub fn validate_provider_arguments(
    arguments: &serde_json::Value,
) -> Result<(), ProviderValidationError> {
    let arguments_len = serde_json::to_vec(arguments)
        .map_err(|error| ProviderValidationError::new(error.to_string()))?
        .len();
    if arguments_len > PROVIDER_ARGUMENTS_MAX_BYTES {
        return Err(ProviderValidationError::new(
            provider_arguments_too_large_summary(),
        ));
    }
    validate_provider_json_value(arguments, "provider arguments", 0)
}

pub fn provider_arguments_exceed_max_bytes(arguments: &serde_json::Value) -> bool {
    serde_json::to_vec(arguments)
        .map(|bytes| bytes.len() > PROVIDER_ARGUMENTS_MAX_BYTES)
        .unwrap_or(false)
}

pub fn is_provider_arguments_too_large_summary(value: &str) -> bool {
    value == provider_arguments_too_large_summary()
}

fn provider_arguments_too_large_summary() -> String {
    format!("provider tool arguments exceed {PROVIDER_ARGUMENTS_MAX_BYTES} bytes")
}

pub fn validate_optional_provider_metadata_text(
    value: Option<&str>,
    label: &str,
    max_len: usize,
) -> Result<(), ProviderValidationError> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.len() > max_len {
        return Err(ProviderValidationError::new(format!(
            "{label} exceeds {max_len} bytes"
        )));
    }
    validate_provider_metadata_text(value, label)
}

pub fn validate_optional_provider_reasoning_details(
    details: Option<&ReasoningDetails>,
) -> Result<(), ProviderValidationError> {
    let Some(details) = details else {
        return Ok(());
    };
    validate_optional_provider_metadata_text(
        details.id.as_deref(),
        "provider reasoning id",
        PROVIDER_REASONING_REFERENCE_MAX_BYTES,
    )?;
    if details.content.len() > PROVIDER_REASONING_DETAILS_MAX_ITEMS {
        return Err(ProviderValidationError::new(format!(
            "provider reasoning details exceed {PROVIDER_REASONING_DETAILS_MAX_ITEMS} items"
        )));
    }

    let mut content_bytes = 0usize;
    for detail in &details.content {
        match detail {
            ReasoningDetail::Text { text, signature } => {
                validate_reasoning_content(text, "provider reasoning text", &mut content_bytes)?;
                validate_optional_provider_metadata_text(
                    signature.as_deref(),
                    "provider reasoning signature",
                    PROVIDER_REASONING_REFERENCE_MAX_BYTES,
                )?;
            }
            ReasoningDetail::Encrypted(text) => validate_reasoning_content(
                text,
                "provider encrypted reasoning content",
                &mut content_bytes,
            )?,
            ReasoningDetail::Redacted { data } => validate_reasoning_content(
                data,
                "provider redacted reasoning content",
                &mut content_bytes,
            )?,
            ReasoningDetail::Summary(text) => {
                validate_reasoning_content(text, "provider reasoning summary", &mut content_bytes)?
            }
        }
    }
    Ok(())
}

fn validate_reasoning_content(
    value: &str,
    label: &str,
    content_bytes: &mut usize,
) -> Result<(), ProviderValidationError> {
    validate_optional_provider_metadata_text(Some(value), label, PROVIDER_METADATA_TEXT_MAX_BYTES)?;
    *content_bytes = content_bytes.saturating_add(value.len());
    if *content_bytes > PROVIDER_REASONING_DETAILS_MAX_CONTENT_BYTES {
        return Err(ProviderValidationError::new(format!(
            "provider reasoning content exceeds {PROVIDER_REASONING_DETAILS_MAX_CONTENT_BYTES} bytes"
        )));
    }
    Ok(())
}

fn validate_provider_json_value(
    value: &serde_json::Value,
    label: &str,
    depth: usize,
) -> Result<(), ProviderValidationError> {
    if depth > PROVIDER_ARGUMENTS_MAX_DEPTH {
        return Err(ProviderValidationError::new(format!(
            "{label} exceed maximum nesting depth"
        )));
    }
    match value {
        serde_json::Value::String(text) => validate_provider_argument_text(text, label),
        serde_json::Value::Array(items) => {
            for item in items {
                validate_provider_json_value(item, label, depth + 1)?;
            }
            Ok(())
        }
        serde_json::Value::Object(entries) => {
            for (key, item) in entries {
                validate_provider_json_key(key)?;
                validate_provider_json_value(item, label, depth + 1)?;
            }
            Ok(())
        }
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {
            Ok(())
        }
    }
}

fn validate_provider_json_key(key: &str) -> Result<(), ProviderValidationError> {
    if key
        .chars()
        .any(|character| character == '\0' || character.is_control())
    {
        return Err(ProviderValidationError::new(
            "provider argument key must not contain NUL/control characters",
        ));
    }
    Ok(())
}

fn validate_provider_metadata_text(
    value: &str,
    label: &str,
) -> Result<(), ProviderValidationError> {
    if value.chars().any(|character| {
        character == '\0' || (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    }) {
        return Err(ProviderValidationError::new(format!(
            "{label} must not contain NUL/control characters"
        )));
    }
    // Sensitive content is gated by the entropy-based LeakDetector below, NOT by
    // crude substring markers. Words like "password" / "traceback" / "secret"
    // legitimately appear in model reasoning when analyzing logs, security
    // findings, or auth flows; blocking the bare words produced false-positive
    // rejections that the model could not satisfy, driving retry/give-up loops
    // (nearai/benchmarks pinchbench taxonomy bucket D). The LeakDetector still
    // catches actual secret-like tokens (API keys, high-entropy values), which
    // is the real guard here.
    reject_provider_secret_leaks(value, label)
}

fn validate_provider_argument_text(
    value: &str,
    label: &str,
) -> Result<(), ProviderValidationError> {
    if value.chars().any(|character| {
        character == '\0' || (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    }) {
        return Err(ProviderValidationError::new(format!(
            "{label} must not contain NUL/control characters"
        )));
    }
    reject_provider_secret_leaks(value, label)
}

fn reject_provider_secret_leaks(value: &str, label: &str) -> Result<(), ProviderValidationError> {
    static DETECTOR: OnceLock<LeakDetector> = OnceLock::new();
    let result = DETECTOR.get_or_init(LeakDetector::new).scan(value);
    if result.should_block || result.redacted_content.is_some() {
        return Err(ProviderValidationError::new(format!(
            "{label} must not contain secret-like tokens"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_arguments_allow_multiline_text() {
        validate_provider_arguments(&serde_json::json!({
            "content": "---\r\nname: pasted-skill\n---\n\nUse multiline Markdown.\n\t- with tabs\n"
        }))
        .expect("multiline provider argument text is valid");
    }

    #[test]
    fn provider_arguments_reject_non_whitespace_controls() {
        let error = validate_provider_arguments(&serde_json::json!({
            "content": "line one\u{0001}line two"
        }))
        .expect_err("non-whitespace control character should fail");

        assert!(error.to_string().contains("NUL/control characters"));
    }

    #[test]
    fn provider_arguments_too_large_summary_matches_validator_error() {
        let arguments = serde_json::json!({"content": "x".repeat(PROVIDER_ARGUMENTS_MAX_BYTES)});
        assert!(provider_arguments_exceed_max_bytes(&arguments));

        let error = validate_provider_arguments(&arguments)
            .expect_err("arguments exceeding the provider byte limit should fail");
        assert!(is_provider_arguments_too_large_summary(&error.to_string()));
    }

    #[test]
    fn provider_reasoning_details_validate_structure_without_json_overhead() {
        let details = ReasoningDetails {
            id: Some("i".repeat(PROVIDER_REASONING_REFERENCE_MAX_BYTES)),
            content: vec![ReasoningDetail::Text {
                text: "x".repeat(16_350),
                signature: Some("s".repeat(PROVIDER_REASONING_REFERENCE_MAX_BYTES)),
            }],
        };

        validate_optional_provider_reasoning_details(Some(&details))
            .expect("valid fields must not be charged for serialized envelope overhead");
    }

    #[test]
    fn provider_reasoning_details_reject_field_count_and_aggregate_overflow() {
        let oversized_field = ReasoningDetails {
            id: None,
            content: vec![ReasoningDetail::Summary(
                "x".repeat(PROVIDER_METADATA_TEXT_MAX_BYTES + 1),
            )],
        };
        assert!(validate_optional_provider_reasoning_details(Some(&oversized_field)).is_err());

        let too_many = ReasoningDetails {
            id: None,
            content: (0..PROVIDER_REASONING_DETAILS_MAX_ITEMS + 1)
                .map(|_| ReasoningDetail::Summary(String::new()))
                .collect(),
        };
        assert!(validate_optional_provider_reasoning_details(Some(&too_many)).is_err());

        let aggregate_overflow = ReasoningDetails {
            id: None,
            content: (0..5)
                .map(|_| ReasoningDetail::Summary("x".repeat(16 * 1024)))
                .collect(),
        };
        assert!(validate_optional_provider_reasoning_details(Some(&aggregate_overflow)).is_err());
    }

    #[test]
    fn provider_metadata_allows_sensitive_words_gated_only_by_leak_detector() {
        // Bucket D fix: bare English words like "provider error" / "traceback" /
        // "password" are no longer rejected by crude substring markers. They
        // legitimately appear in model reasoning about logs, security findings,
        // or auth flows. The entropy-based LeakDetector remains the sole guard
        // and still catches actual secret-like tokens.
        validate_optional_provider_metadata_text(
            Some("provider error included a traceback; the user's password had expired"),
            "provider reasoning",
            PROVIDER_METADATA_TEXT_MAX_BYTES,
        )
        .expect("sensitive English words must pass; only the LeakDetector gates real secrets");
    }

    #[test]
    fn provider_metadata_allows_multiline_text() {
        for value in [
            "line one\nline two",
            "line one\rline two",
            "line one\tline two",
        ] {
            validate_optional_provider_metadata_text(Some(value), "provider reasoning", 4096)
                .expect("metadata text whitespace control should pass");
        }
    }

    #[test]
    fn provider_metadata_rejects_non_whitespace_controls() {
        let error = validate_optional_provider_metadata_text(
            Some("line one\u{0001}line two"),
            "provider reasoning",
            4096,
        )
        .expect_err("non-whitespace control character should fail");

        assert!(error.to_string().contains("NUL/control characters"));
    }

    #[test]
    fn provider_text_rejects_secret_like_tokens() {
        let api_key = format!("sk-proj-{}", "a".repeat(24));
        let error = validate_provider_arguments(&serde_json::json!({"api_key": api_key}))
            .expect_err("secret-like token should fail");

        assert!(error.to_string().contains("secret-like tokens"));
    }
}
