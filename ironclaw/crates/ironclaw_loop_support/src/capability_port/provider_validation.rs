use ironclaw_safety::{
    PROVIDER_METADATA_TEXT_MAX_BYTES, ProviderValidationError,
    validate_optional_provider_metadata_text, validate_optional_provider_reasoning_details,
    validate_provider_arguments as validate_safety_provider_arguments, validate_provider_identity,
    validate_provider_token, validate_provider_tool_name as validate_safety_provider_tool_name,
};
use ironclaw_turns::{
    MAX_CHECKPOINT_STATE_PAYLOAD_BYTES,
    run_profile::{
        AgentLoopHostError, AgentLoopHostErrorKind, CapabilityAuthResumeReplay, ProviderToolCall,
        ProviderToolCallReplay,
    },
};

pub(super) use ironclaw_safety::PROVIDER_TOOL_NAME_MAX_BYTES;

const REPRESENTATIVE_GATE_OVERHEAD_HEADROOM_BYTES: usize = 8 * 1024;

pub(super) fn validate_provider_tool_call(
    tool_call: &ProviderToolCall,
) -> Result<(), AgentLoopHostError> {
    validate_provider_identity(&tool_call.provider_id, "provider id", 512)
        .map_err(invalid_invocation)?;
    validate_provider_identity(&tool_call.provider_model_id, "provider model id", 512)
        .map_err(invalid_invocation)?;
    let turn_id = tool_call.turn_id.as_deref().ok_or_else(|| {
        AgentLoopHostError::new(
            AgentLoopHostErrorKind::InvalidInvocation,
            "provider tool call is missing a provider turn id",
        )
    })?;
    validate_provider_token(turn_id, "provider turn id", 512).map_err(invalid_invocation)?;
    validate_provider_token(&tool_call.id, "provider call id", 512).map_err(invalid_invocation)?;
    validate_provider_tool_name(tool_call.name.as_str())?;
    validate_provider_arguments(&tool_call.arguments)?;
    validate_optional_provider_reasoning_details(tool_call.reasoning_details.as_ref())
        .map_err(invalid_invocation)?;
    validate_optional_provider_metadata_text(
        tool_call.response_reasoning.as_deref(),
        "provider response reasoning",
        PROVIDER_METADATA_TEXT_MAX_BYTES,
    )
    .map_err(invalid_invocation)?;
    validate_optional_provider_metadata_text(
        tool_call.reasoning.as_deref(),
        "provider reasoning",
        PROVIDER_METADATA_TEXT_MAX_BYTES,
    )
    .map_err(invalid_invocation)?;
    validate_optional_provider_metadata_text(
        tool_call.signature.as_deref(),
        "provider signature",
        PROVIDER_METADATA_TEXT_MAX_BYTES,
    )
    .map_err(invalid_invocation)?;
    validate_provider_tool_call_checkpoint_replay_budget(tool_call)?;
    Ok(())
}

pub(super) fn validate_provider_tool_name(value: &str) -> Result<(), AgentLoopHostError> {
    validate_safety_provider_tool_name(value).map_err(invalid_invocation)
}

pub(super) fn validate_provider_arguments(
    arguments: &serde_json::Value,
) -> Result<(), AgentLoopHostError> {
    validate_safety_provider_arguments(arguments).map_err(invalid_invocation)
}

fn validate_provider_tool_call_checkpoint_replay_budget(
    tool_call: &ProviderToolCall,
) -> Result<(), AgentLoopHostError> {
    let replay = ProviderToolCallReplay {
        provider_id: tool_call.provider_id.clone(),
        provider_model_id: tool_call.provider_model_id.clone(),
        provider_turn_id: tool_call.turn_id.clone().unwrap_or_default(),
        provider_call_id: tool_call.id.clone(),
        provider_tool_name: tool_call.name.clone(),
        arguments: tool_call.arguments.clone(),
        reasoning_details: tool_call.reasoning_details.clone(),
        response_reasoning: tool_call.response_reasoning.clone(),
        reasoning: tool_call.reasoning.clone(),
        signature: tool_call.signature.clone(),
    };
    let approval_payload = serde_json::to_vec(&serde_json::json!({
        "provider_replay": &replay,
        "input": {"extension_id": "representative_auth_extension", "team": "workspace"},
        "estimate": representative_gate_estimate(),
        "surface_version": "surface-v1",
        "effective_capability_ids": ["demo.echo"],
        "gate_ref": "gate:representative-approval",
        "resume_token": "00000000-0000-0000-0000-000000000123",
        "approval_request_id": "00000000-0000-0000-0000-000000000124",
        "correlation_id": "00000000-0000-0000-0000-000000000125",
        "activity_id": "00000000-0000-0000-0000-000000000126",
        "input_ref": "input:representative-approval"
    }))
    .map_err(invalid_invocation_from_serde)?;
    let auth_payload = serde_json::to_vec(&serde_json::json!({
        "provider_replay": &replay,
        "replay": CapabilityAuthResumeReplay {
            input: serde_json::json!({
                "extension_id": "representative_auth_extension",
                "scopes": ["calendar.read", "mail.read"]
            }),
            estimate: representative_gate_estimate(),
        },
        "surface_version": "surface-v1",
        "effective_capability_ids": ["demo.echo"],
        "gate_ref": "gate:representative-auth",
        "activity_id": "00000000-0000-0000-0000-000000000126",
        "input_ref": "input:representative-auth"
    }))
    .map_err(invalid_invocation_from_serde)?;
    let max_payload = approval_payload.len().max(auth_payload.len());
    let budget = MAX_CHECKPOINT_STATE_PAYLOAD_BYTES
        .saturating_sub(REPRESENTATIVE_GATE_OVERHEAD_HEADROOM_BYTES);
    if max_payload > budget {
        return Err(AgentLoopHostError::new(
            AgentLoopHostErrorKind::InvalidInvocation,
            format!("provider tool call replay exceeds checkpoint-safe budget of {budget} bytes"),
        ));
    }
    Ok(())
}

fn representative_gate_estimate() -> ironclaw_host_api::ResourceEstimate {
    ironclaw_host_api::ResourceEstimate::default()
}

fn invalid_invocation_from_serde(error: serde_json::Error) -> AgentLoopHostError {
    AgentLoopHostError::new(
        AgentLoopHostErrorKind::InvalidInvocation,
        format!(
            "provider tool call replay budget check could not serialize representative checkpoint payload: {error}"
        ),
    )
}

fn invalid_invocation(error: ProviderValidationError) -> AgentLoopHostError {
    let safe_summary = error.to_string();
    crate::raw_agent_loop_host_error(
        "capability_provider_validation",
        "validate_provider_arguments",
        AgentLoopHostErrorKind::InvalidInvocation,
        safe_summary,
        error,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironclaw_host_api::ProviderToolName;

    fn provider_name(value: &str) -> ProviderToolName {
        ProviderToolName::new(value).expect("provider tool name")
    }

    #[test]
    fn provider_tool_call_validation_rejects_provider_unsafe_tool_name() {
        let error = validate_provider_tool_name("demo.echo").expect_err("unsafe name rejected");
        assert_eq!(error.kind, AgentLoopHostErrorKind::InvalidInvocation);
    }

    #[test]
    fn provider_tool_call_validation_requires_turn_id() {
        let mut call = provider_tool_call();
        call.turn_id = None;

        let error = validate_provider_tool_call(&call).expect_err("missing turn id rejected");
        assert_eq!(error.kind, AgentLoopHostErrorKind::InvalidInvocation);
    }

    #[test]
    fn provider_tool_call_validation_rejects_sensitive_metadata() {
        // Arguments carrying a real secret-like token are rejected by the
        // entropy-based leak scan, which is the canonical guard after #5001
        // dropped the crude bare-word substring markers.
        let mut call = provider_tool_call();
        let api_key = format!("sk-proj-{}", "a".repeat(24));
        call.arguments = serde_json::json!({"password": api_key});
        assert!(validate_provider_tool_call(&call).is_err());

        // The same leak scan runs over model-emitted reasoning, so a leaked
        // secret-like token there is rejected even though bare words like
        // "traceback" are now intentionally allowed (#5001, PinchBench bucket D).
        let mut call = provider_tool_call();
        call.reasoning = Some(format!("provider error leaked sk-proj-{}", "b".repeat(24)));
        assert!(validate_provider_tool_call(&call).is_err());
    }

    #[test]
    fn provider_tool_call_validation_allows_multiline_response_reasoning() {
        let mut call = provider_tool_call();
        call.response_reasoning = Some(
            "**Investigating root cause**\n\nChecked provider output and projection flow."
                .to_string(),
        );

        validate_provider_tool_call(&call)
            .expect("multiline provider response reasoning should be valid");
    }

    #[test]
    fn provider_tool_call_validation_rejects_non_whitespace_response_reasoning_controls() {
        let mut call = provider_tool_call();
        call.response_reasoning = Some("line one\u{0001}line two".to_string());

        let error = validate_provider_tool_call(&call)
            .expect_err("non-whitespace response reasoning control should fail");
        assert_eq!(error.kind, AgentLoopHostErrorKind::InvalidInvocation);
    }

    #[test]
    fn provider_tool_call_validation_allows_multiline_argument_text() {
        let mut call = provider_tool_call();
        call.arguments = serde_json::json!({
            "content": "---\nname: pasted-skill\n---\n\nMention an API key placeholder, but no secret.\n"
        });

        validate_provider_tool_call(&call).expect("multiline argument text should be valid");
    }

    #[test]
    fn provider_tool_call_validation_rejects_checkpoint_unsafe_replay_budget() {
        let mut call = provider_tool_call();
        call.arguments = serde_json::json!({"content": "x".repeat(20_000)});
        call.reasoning_details = Some(ironclaw_common::ReasoningDetails {
            id: Some("i".repeat(4096)),
            content: vec![
                ironclaw_common::ReasoningDetail::Text {
                    text: "x".repeat(16_350),
                    signature: Some("s".repeat(4096)),
                },
                ironclaw_common::ReasoningDetail::Text {
                    text: "x".repeat(16_350),
                    signature: Some("t".repeat(4096)),
                },
            ],
        });

        let error = validate_provider_tool_call(&call)
            .expect_err("checkpoint-unsafe replay must be rejected before dispatch");
        assert_eq!(error.kind, AgentLoopHostErrorKind::InvalidInvocation);
        assert!(error.safe_summary.contains("checkpoint-safe budget"));
    }

    #[test]
    fn provider_tool_call_validation_accepts_max_single_text_reasoning_with_small_arguments() {
        let mut call = provider_tool_call();
        call.reasoning_details = Some(ironclaw_common::ReasoningDetails {
            id: Some("i".repeat(4096)),
            content: vec![ironclaw_common::ReasoningDetail::Text {
                text: "x".repeat(16_350),
                signature: Some("s".repeat(4096)),
            }],
        });

        validate_provider_tool_call(&call)
            .expect("single 16,350-byte typed reasoning block with small arguments stays valid");
    }

    fn provider_tool_call() -> ProviderToolCall {
        ProviderToolCall {
            provider_id: "provider".to_string(),
            provider_model_id: "model".to_string(),
            turn_id: Some("turn_1".to_string()),
            id: "call_1".to_string(),
            name: provider_name("demo__echo"),
            arguments: serde_json::json!({"message":"hello"}),
            reasoning_details: None,
            response_reasoning: None,
            reasoning: None,
            signature: None,
        }
    }
}
