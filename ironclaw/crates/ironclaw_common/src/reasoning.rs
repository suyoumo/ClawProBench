//! Provider reasoning artifacts that require exact replay across tool follow-ups.

use serde::{Deserialize, Serialize};

/// One ordered provider reasoning artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "content", rename_all = "snake_case")]
pub enum ReasoningDetail {
    /// Plain reasoning text with an optional provider signature.
    Text {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    /// Provider-encrypted reasoning payload.
    Encrypted(String),
    /// Redacted reasoning payload preserved as opaque data.
    Redacted { data: String },
    /// Provider-generated reasoning summary text.
    Summary(String),
}

/// Ordered provider reasoning payload with an optional provider-supplied ID.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReasoningDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub content: Vec<ReasoningDetail>,
}

impl ReasoningDetails {
    pub fn from_text(text: impl Into<String>) -> Option<Self> {
        let text = text.into();
        if text.trim().is_empty() {
            return None;
        }
        Some(Self {
            id: None,
            content: vec![ReasoningDetail::Text {
                text,
                signature: None,
            }],
        })
    }

    pub fn is_empty(&self) -> bool {
        self.content.is_empty()
            || self.content.iter().all(|detail| match detail {
                ReasoningDetail::Text { text, signature } => {
                    text.trim().is_empty() && signature.as_ref().is_none_or(|s| s.trim().is_empty())
                }
                ReasoningDetail::Encrypted(text) | ReasoningDetail::Summary(text) => {
                    text.trim().is_empty()
                }
                ReasoningDetail::Redacted { data } => data.trim().is_empty(),
            })
    }

    pub fn display_text(&self) -> Option<String> {
        let parts = self
            .content
            .iter()
            .filter_map(|detail| match detail {
                ReasoningDetail::Text { text, .. } | ReasoningDetail::Summary(text)
                    if !text.trim().is_empty() =>
                {
                    Some(text.as_str())
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        if parts.is_empty() {
            None
        } else {
            Some(parts.join("\n"))
        }
    }
}
