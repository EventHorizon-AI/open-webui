from __future__ import annotations

import logging
import re
from copy import deepcopy
from typing import Any

from fastapi.responses import JSONResponse
from open_webui.models.chats import Chats
from open_webui.models.config import Config
from open_webui.utils.chat_id import is_saved_chat_id
from open_webui.utils.json_codec import JSONCodec
from open_webui.utils.misc import (
    get_content_from_message,
    get_last_user_message,
    get_message_list,
)
from open_webui.utils.payload import apply_params_to_form_data
from open_webui.utils.task import (
    prompt_template,
    prompt_variables_template,
    replace_messages_variable,
    replace_prompt_variable,
    truncate_content,
)

log = logging.getLogger(__name__)

# The messages being compacted are sent to the compaction model as real chat
# messages; this template is the trailing user turn that asks for the summary.
# The retained (kept-in-context) messages are not injected: they stay in the
# model's context anyway.
BASE64_DATA_URI_RE = re.compile(r'data:[\w/+.;=%-]*;base64,[A-Za-z0-9+/=]*')

DEFAULT_CONTEXT_COMPACTION_PROMPT = """### Task:
Summarize the conversation above that will be compacted out of the active chat context.

### Instructions:
- Preserve key decisions, user preferences, and constraints.
- Preserve files, artifacts, tool results, and code changes that matter going forward.
- Preserve the current task state, unresolved questions, and next steps.
- Be factual and specific. Do not invent details.
- Keep the summary concise, but complete enough for the assistant to continue without the removed messages.

### Previous Summary:
{{PREVIOUS_SUMMARY}}"""


async def compact_messages_for_request(
    request,
    user,
    messages: list[dict],
    metadata: dict,
    model_id: str,
    models: dict,
    system_prompt: str = '',
) -> tuple[list[dict], str | None, bool]:
    config = await load_compaction_config()
    if not config['enable']:
        return messages, None, False

    system_messages = [messages[0]] if messages and messages[0].get('role') == 'system' else []
    messages = messages[1:] if system_messages else messages

    previous_summary = current_summary(messages)
    messages, _ = _apply_latest_summary_checkpoint(messages)
    system_prompt = system_prompt or (get_content_from_message(system_messages[0]) if system_messages else '')
    token_threshold = _resolve_token_threshold(config['token_threshold'], config['token_cap'], metadata)
    if not _exceeds_token_threshold(messages, system_prompt, previous_summary, token_threshold) or len(messages) <= 3:
        return [*system_messages, *messages], previous_summary, False

    boundary = _find_compaction_boundary(messages, config['retention_percentage'])
    compacted_messages = messages[:boundary]
    recent_messages = messages[boundary:]
    if not compacted_messages or not recent_messages:
        return [*system_messages, *messages], previous_summary, False

    summary = await _summarize_with_events(
        request,
        user,
        metadata,
        model_id,
        models,
        compacted_messages,
        recent_messages,
        previous_summary,
        config['prompt_template'],
    )

    chat_id = metadata.get('chat_id')
    checkpoint_message_id = (
        recent_messages[0].get('id') or metadata.get('user_message_id') or metadata.get('message_id')
    )
    if is_saved_chat_id(chat_id) and checkpoint_message_id:
        await Chats.upsert_message_to_chat_by_id_and_message_id(
            chat_id,
            checkpoint_message_id,
            {'contextSummary': summary},
            touch=False,
        )

    log.debug(
        'Compacted chat context for chat=%s checkpoint=%s response=%s dropped=%d kept=%d summary_chars=%d',
        chat_id,
        checkpoint_message_id,
        metadata.get('message_id'),
        len(compacted_messages),
        len(recent_messages),
        len(summary),
    )

    return [*system_messages, *recent_messages], summary, True


# Plans a mid-turn cut and returns its summary/count; the caller stores the
# checkpoint (the compacted tool messages have no chat rows to sit on).
async def plan_mid_turn_compaction(
    request,
    user,
    messages: list[dict],
    metadata: dict,
    model_id: str,
    models: dict,
    config: dict,
    prompt_tokens: int | None,
    pinned_count: int,
    previous_summary: str | None,
) -> tuple[str | None, int]:
    threshold = _resolve_token_threshold(config['token_threshold'], config['token_cap'], metadata)
    if max(prompt_tokens or 0, _estimate_messages_tokens(messages)) <= threshold:
        return None, 0

    system_messages = [messages[0]] if messages and messages[0].get('role') == 'system' else []
    messages = messages[1:] if system_messages else messages
    if len(messages) <= 3:
        return None, 0

    boundary = _find_compaction_boundary(messages, config['retention_percentage'])
    # A cut at or before the pin drops nothing, since the caller re-adds it.
    if boundary <= pinned_count:
        return None, 0

    # The summary request gets the full prefix — the leading system message plus
    # the messages being cut — so it starts identically to the tool-loop prompt
    # and providers with prefix caching can reuse the cached context.
    compacted_messages = [*system_messages, *messages[:boundary]]
    recent_messages = messages[boundary:]
    summary = await _summarize_with_events(
        request,
        user,
        metadata,
        model_id,
        models,
        compacted_messages,
        recent_messages,
        previous_summary,
        config['prompt_template'],
    )
    # Dropping messages without anything standing in for them loses the context outright.
    if not summary:
        return None, 0

    log.debug(
        'Planned mid-turn context cut for chat=%s response=%s dropped=%d kept=%d summary_chars=%d',
        metadata.get('chat_id'),
        metadata.get('message_id'),
        boundary - pinned_count,
        len(recent_messages),
        len(summary),
    )

    return summary, boundary - pinned_count


# The rolling summary lives as a single block (``[CONVERSATION SUMMARY]\n...``)
# inside the leading system message. A new summary replaces the previous one by
# exact text match, so it never accumulates — no delimiters or regex needed.
def _summary_block(summary: str) -> str:
    return f'[CONVERSATION SUMMARY]\n{summary}'


def _replace_summary_text(text: str, block: str, previous_block: str | None) -> str:
    if previous_block and previous_block in text:
        return text.replace(previous_block, block, 1)
    return f'{text}\n{block}' if text else block


def _with_summary_block(content: Any, block: str, previous_block: str | None) -> Any:
    if isinstance(content, list):
        items = [dict(item) if isinstance(item, dict) else item for item in content]
        for index, item in enumerate(items):
            if isinstance(item, dict) and item.get('type') == 'text':
                items[index] = {**item, 'text': _replace_summary_text(item.get('text', ''), block, previous_block)}
                return items
        items.append({'type': 'text', 'text': block})
        return items
    return _replace_summary_text(content if isinstance(content, str) else '', block, previous_block)


def set_conversation_summary(
    messages: list[dict], summary: str | None, previous_summary: str | None = None
) -> list[dict]:
    """Return a copy of messages with the rolling summary as a single block in
    the leading system message.

    The previous block (built from ``previous_summary``) is replaced in place by
    exact text match, so the summary never stacks.
    """
    if not summary:
        return messages
    block = _summary_block(summary)
    previous_block = _summary_block(previous_summary) if previous_summary else None
    if messages and messages[0].get('role') == 'system':
        system = messages[0]
        return [
            {**system, 'content': _with_summary_block(system.get('content'), block, previous_block)},
            *messages[1:],
        ]
    return [{'role': 'system', 'content': block}, *messages]


def current_summary(messages: list[dict]) -> str | None:
    """Return the newest stored summary along the message chain.

    The chain is chronological, so scanning backwards yields the latest one — no
    timestamp needed. The mid-turn summary lives on an ``output`` item
    (``context_summary``); the chat-level checkpoint lives on the message
    (``contextSummary``). ``meta['contextCompaction']['summary']`` is a legacy
    fallback.
    """
    for message in reversed(messages):
        value = message.get('contextSummary') or message.get('context_summary')
        if isinstance(value, str) and value.strip():
            return value

        output = message.get('output')
        if isinstance(output, list):
            for item in reversed(output):
                if isinstance(item, dict):
                    value = item.get('context_summary')
                    if isinstance(value, str) and value.strip():
                        return value

        checkpoint = message.get('contextCompaction')
        if not isinstance(checkpoint, dict):
            meta = message.get('meta')
            checkpoint = meta.get('contextCompaction') if isinstance(meta, dict) else None
        if isinstance(checkpoint, dict):
            value = checkpoint.get('summary')
            if isinstance(value, str) and value.strip():
                return value
    return None


# The pinned count it returns shifts the indices the next plan call reports against.
def apply_mid_turn_compaction(
    messages: list[dict],
    compacted_count: int,
    task_message: dict | None,
    summary: str | None = None,
    previous_summary: str | None = None,
) -> tuple[list[dict], int]:
    if compacted_count:
        # Copied because the caller may reuse the prefix across iterations.
        system_messages = [deepcopy(messages[0])] if messages and messages[0].get('role') == 'system' else []
        recent_messages = (messages[1:] if system_messages else messages)[compacted_count:]

        # Without the request the run is working towards, the model abandons the task early.
        pinned_count = 1 if task_message and not any(message is task_message for message in recent_messages) else 0
        if pinned_count:
            recent_messages = [task_message, *recent_messages]

        compacted = [*system_messages, *recent_messages]
    else:
        compacted, pinned_count = messages, 0

    if summary:
        compacted = set_conversation_summary(compacted, summary, previous_summary)
    return compacted, pinned_count


def get_stored_mid_turn_compaction(messages: list[dict]) -> dict | None:
    """Return the latest stored mid-turn compaction checkpoint, if any.

    The checkpoint is promoted onto the message's ``contextCompaction`` key
    (from ``meta['contextCompaction']``) when messages are rebuilt for replay.
    """
    checkpoint = None
    for message in messages:
        value = message.get('contextCompaction')
        if not isinstance(value, dict):
            meta = message.get('meta')
            value = meta.get('contextCompaction') if isinstance(meta, dict) else None
        if isinstance(value, dict):
            checkpoint = value
    return checkpoint


async def store_mid_turn_compaction(metadata: dict, checkpoint: dict) -> dict | None:
    """Store a mid-turn compaction checkpoint on the turn's message meta.

    Prefers the assistant message, but falls back to the user message (which
    always exists) so a checkpoint is never lost to an uncreated row and no
    half-formed row is created just to hold it. Returns the merged meta so
    callers can mirror it in the response, or None when it cannot be stored.
    """
    chat_id = metadata.get('chat_id')
    if not is_saved_chat_id(chat_id):
        return None

    assistant_message_id = metadata.get('message_id')
    target_id = assistant_message_id
    if assistant_message_id:
        if not await Chats.get_message_by_id_and_message_id(chat_id, assistant_message_id):
            target_id = metadata.get('user_message_id')
    else:
        target_id = metadata.get('user_message_id')

    if not target_id:
        return None

    existing = await Chats.get_message_by_id_and_message_id(chat_id, target_id) or {}
    existing_meta = existing.get('meta') if isinstance(existing.get('meta'), dict) else {}
    merged_meta = {**existing_meta, 'contextCompaction': checkpoint}

    await Chats.upsert_message_to_chat_by_id_and_message_id(
        chat_id,
        target_id,
        {'meta': merged_meta},
        touch=False,
    )
    return merged_meta


def _anchor_drop_count(messages: list[dict], call_id: str) -> int | None:
    """Count the non-system messages before the expanded message produced by
    ``call_id`` (the cut anchor), or None if it isn't present."""
    leading_system = 1 if messages and messages[0].get('role') == 'system' else 0
    count = 0
    for index, message in enumerate(messages):
        if index < leading_system:
            continue
        role = message.get('role')
        if role == 'assistant' and any(
            tool_call.get('id') == call_id for tool_call in (message.get('tool_calls') or [])
        ):
            return count
        if role == 'tool' and message.get('tool_call_id') == call_id:
            return count
        count += 1
    return None


def apply_stored_mid_turn_compaction(
    processed_messages: list[dict], source_messages: list[dict], task_message: dict | None = None
) -> list[dict]:
    """Re-apply a stored mid-turn compaction cut after output expansion.

    Only the cut is applied here; the summary is written as the single system
    block by the caller. The cut is anchored on the first retained tool call
    (``anchor.call_id``) when available — robust to expansion changes — and falls
    back to the stored ``drop`` count. ``task_message`` is re-pinned exactly as
    the tool loop did so the prompt prefix stays byte-identical. Returns the
    messages unchanged when no checkpoint is present.
    """
    checkpoint = get_stored_mid_turn_compaction(source_messages)
    if not checkpoint:
        return processed_messages

    drop = _parse_positive_int(checkpoint.get('drop'))
    anchor = checkpoint.get('anchor')
    if isinstance(anchor, dict) and isinstance(anchor.get('call_id'), str):
        anchored = _anchor_drop_count(processed_messages, anchor['call_id'])
        if anchored is not None:
            drop = anchored
    if not drop:
        return processed_messages

    leading_system = 1 if processed_messages and processed_messages[0].get('role') == 'system' else 0
    if drop >= len(processed_messages) - leading_system:
        return processed_messages

    compacted, _ = apply_mid_turn_compaction(processed_messages, drop, task_message)
    return compacted


def resolve_compaction_models(request) -> dict:
    if getattr(request.state, 'direct', False) and hasattr(request.state, 'model'):
        return {**dict(request.app.state.MODELS.items()), request.state.model['id']: request.state.model}
    return request.app.state.MODELS


async def _summarize_with_events(
    request,
    user,
    metadata: dict,
    model_id: str,
    models: dict,
    compacted_messages: list[dict],
    recent_messages: list[dict],
    previous_summary: str | None,
    prompt_template: str,
) -> str:
    event_emitter = None
    if metadata.get('chat_id') and metadata.get('message_id'):
        from open_webui.socket.main import get_event_emitter

        event_emitter = await get_event_emitter(metadata)

    if event_emitter:
        await event_emitter(
            {
                'type': 'context_compaction',
                'data': {
                    'action': 'context_compaction',
                    'description': 'Compacting context',
                    'done': False,
                },
            }
        )

    try:
        summary = await _generate_summary(
            request,
            user,
            model_id,
            models,
            compacted_messages,
            recent_messages,
            previous_summary,
            prompt_template,
        )
    except Exception:
        if event_emitter:
            await event_emitter(
                {
                    'type': 'context_compaction',
                    'data': {
                        'action': 'context_compaction',
                        'description': 'Context compaction failed',
                        'done': True,
                        'error': True,
                    },
                }
            )
        raise

    if event_emitter:
        await event_emitter(
            {
                'type': 'context_compaction',
                'data': {
                    'action': 'context_compaction',
                    'description': 'Context compacted',
                    'done': True,
                },
            }
        )

    return summary


async def compact_chat_branch(request, user, chat: Any, model_id: str, models: dict) -> dict:
    config = await load_compaction_config()
    if not config['enable']:
        return {'ok': True, 'compacted': False, 'reason': 'disabled'}

    chat_data = chat.chat or {}
    history = chat_data.get('history') or {}
    current_id = getattr(chat, 'current_message_id', None) or history.get('currentId')
    if not current_id:
        current_id = chat_data.get('currentId') or chat_data.get('branchPointMessageId')
    if not current_id and isinstance(chat_data.get('messages'), list) and chat_data['messages']:
        current_id = chat_data['messages'][-1].get('id')
    if not current_id:
        return {'ok': True, 'compacted': False, 'reason': 'empty'}

    messages_map = await Chats.get_messages_map_by_chat_id(chat.id)
    if not messages_map:
        messages_map = history.get('messages') or {}

    chain = get_message_list(messages_map, current_id)
    previous_summary = current_summary(chain)
    messages, _ = _apply_latest_summary_checkpoint(chain)
    compacted_messages = messages[:-1]
    recent_messages = messages[-1:]
    if not compacted_messages or not recent_messages:
        return {'ok': True, 'compacted': False, 'reason': 'too_short'}

    summary = await _generate_summary(
        request,
        user,
        model_id,
        models,
        compacted_messages,
        recent_messages,
        previous_summary,
        config['prompt_template'],
    )
    await Chats.upsert_message_to_chat_by_id_and_message_id(
        chat.id, current_id, {'contextSummary': summary}, touch=False
    )

    return {
        'ok': True,
        'compacted': True,
        'dropped_messages': len(compacted_messages),
        'kept_messages': len(recent_messages),
        'summary_chars': len(summary),
    }


async def load_compaction_config() -> dict:
    values = await Config.get_many(
        'chat.context_compaction.enable',
        'chat.context_compaction.token_threshold',
        'chat.context_compaction.token_cap',
        'chat.context_compaction.retention_percentage',
        'chat.context_compaction.prompt_template',
    )
    token_threshold = _parse_positive_int(values.get('chat.context_compaction.token_threshold')) or 80000
    return {
        'enable': bool(values.get('chat.context_compaction.enable', False)),
        'token_threshold': token_threshold,
        'token_cap': _parse_positive_int(values.get('chat.context_compaction.token_cap')) or token_threshold,
        'retention_percentage': _clamp_retention_percentage(values.get('chat.context_compaction.retention_percentage')),
        'prompt_template': values.get('chat.context_compaction.prompt_template', '') or '',
    }


def _parse_positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _clamp_retention_percentage(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = 40
    return min(50, max(10, parsed))


def _resolve_token_threshold(global_threshold: int, global_cap: int, metadata: dict) -> int:
    configured_threshold = _parse_positive_int((metadata.get('params') or {}).get('compact_token_threshold'))
    return min(configured_threshold or global_threshold, global_cap)


def _usage_token_count(usage: dict) -> int:
    prompt_tokens = int(usage.get('prompt_tokens') or usage.get('prompt_eval_count') or 0)
    if not prompt_tokens and (usage.get('prompt_n') is not None or usage.get('cache_n') is not None):
        prompt_tokens = int(usage.get('prompt_n') or 0) + int(usage.get('cache_n') or 0)
    if not prompt_tokens:
        prompt_tokens = int(usage.get('input_tokens') or 0)

    completion_tokens = int(
        usage.get('completion_tokens')
        or usage.get('output_tokens')
        or usage.get('eval_count')
        or usage.get('predicted_n')
        or 0
    )
    return prompt_tokens + completion_tokens


async def get_chat_context_usage(chat: Any, model_id: str | None = None) -> dict | None:
    config = await load_compaction_config()
    if not config['enable']:
        return None

    params = ((chat.chat or {}).get('params') or {}).copy()
    if model_id:
        params['model'] = model_id
    threshold = _resolve_token_threshold(config['token_threshold'], config['token_cap'], {'params': params})

    chat_data = chat.chat or {}
    history = chat_data.get('history') or {}
    current_id = getattr(chat, 'current_message_id', None) or history.get('currentId')
    if not current_id:
        current_id = chat_data.get('currentId') or chat_data.get('branchPointMessageId')
    if not current_id and isinstance(chat_data.get('messages'), list) and chat_data['messages']:
        current_id = chat_data['messages'][-1].get('id')
    if not current_id:
        # Fresh chat with no messages yet: still surface the live resolved
        # threshold so clients can render the context meter immediately.
        return _build_context_usage(0, threshold)

    messages_map = await Chats.get_messages_map_by_chat_id(chat.id)
    messages = get_message_list(messages_map or history.get('messages') or {}, current_id)
    if not messages:
        return _build_context_usage(0, threshold)

    messages, previous_summary = _apply_latest_summary_checkpoint(messages)

    for idx in range(len(messages) - 1, -1, -1):
        usage = messages[idx].get('usage') or (messages[idx].get('info') or {}).get('usage')
        if isinstance(usage, dict) and (tokens := _usage_token_count(usage)):
            tokens += _estimate_messages_tokens(messages[idx + 1 :])
            return _build_context_usage(tokens, threshold)

    tokens = _estimate_tokens(previous_summary or '') + _estimate_messages_tokens(messages)
    return _build_context_usage(tokens, threshold)


def _build_context_usage(tokens: int, threshold: int) -> dict:
    return {
        'tokens': tokens,
        'estimated_tokens': tokens,
        'threshold': threshold,
        'percent': round((tokens / threshold) * 100) if threshold > 0 else 0,
        'source': 'estimated',
    }


def _apply_latest_summary_checkpoint(messages: list[dict]) -> tuple[list[dict], str | None]:
    summary = None
    summary_idx = None

    for idx, message in enumerate(messages):
        value = message.get('contextSummary') or message.get('context_summary')
        if isinstance(value, str) and value.strip():
            summary = value
            summary_idx = idx

    if summary_idx is None:
        return messages, None
    return messages[summary_idx:], summary


def _exceeds_token_threshold(messages: list[dict], system_prompt: str, summary: str | None, threshold: int) -> bool:
    if threshold <= 0:
        return False

    # Expanded tool histories include fresh results and rebuilt prompts absent from prior usage.
    if not any(message.get('role') == 'tool' for message in messages):
        for idx in range(len(messages) - 1, -1, -1):
            usage = messages[idx].get('usage') or (messages[idx].get('info') or {}).get('usage')
            if isinstance(usage, dict) and (tokens := _usage_token_count(usage)):
                return tokens + _estimate_messages_tokens(messages[idx + 1 :]) > threshold

    estimated = _estimate_tokens(system_prompt) + _estimate_tokens(summary or '') + _estimate_messages_tokens(messages)
    return estimated > threshold


def _find_compaction_boundary(messages: list[dict], retention_percentage: int = 40) -> int:
    retention_percentage = _clamp_retention_percentage(retention_percentage)
    keep_count = max(2, len(messages) * retention_percentage // 100)
    target = max(1, len(messages) - keep_count)
    # A single agentic turn has no later user message to clamp to, so tool blocks are cut points too.
    cut_points = [idx for idx, message in enumerate(messages) if message.get('role') == 'user'][1:]
    cut_points += _find_tool_block_starts(messages)
    return max((idx for idx in cut_points if idx <= target), default=0)


# Indices where no tool call is still awaiting its result, matched by id because parallel calls
# can come back in any order.
def _find_tool_block_starts(messages: list[dict]) -> list[int]:
    block_starts = []
    unanswered_tool_call_ids = set()
    inside_tool_calling = False

    for idx, message in enumerate(messages):
        # Only the start of a later block, so plain turns stay whole and are cut on the user list.
        if inside_tool_calling and not unanswered_tool_call_ids and message.get('tool_calls'):
            block_starts.append(idx)

        if message.get('role') == 'tool' and message.get('tool_call_id'):
            unanswered_tool_call_ids.discard(message['tool_call_id'])
        for tool_call in message.get('tool_calls') or []:
            if tool_call.get('id'):
                unanswered_tool_call_ids.add(tool_call['id'])
                inside_tool_calling = True

    return block_starts


# Used for the retained messages, which are still rendered into the template as
# ``ROLE: content`` text (not sent as real messages).
def _message_prompt_text(message: dict) -> str:
    content = get_content_from_message(message)
    return f'{message.get("role", "unknown").upper()}: {content or ""}'


def _rendered_message_tokens(message: dict) -> int:
    return _estimate_tokens(_message_prompt_text(message))


# Used for the compacted messages, which are sent as real chat messages.
def _message_tokens(message: dict) -> int:
    return _estimate_messages_tokens([message])


def _estimate_prompt_messages_tokens(messages: list[dict]) -> int:
    return sum(_rendered_message_tokens(message) for message in messages)


def _truncate_message_for_prompt(message: dict, max_tokens: int) -> dict:
    """Copy a message with its content capped so it can fit a chunk alone."""
    text = get_content_from_message(message) or ''
    if not isinstance(text, str):
        text = str(text)

    max_chars = max(0, max_tokens) * 4
    if len(text) <= max_chars:
        return message
    return {**message, 'content': truncate_content(text, max_chars), 'output': None}


def _chunk_messages_for_summary(
    messages: list[dict], budget_tokens: int, estimator=_message_tokens
) -> list[list[dict]]:
    """Split messages into consecutive groups that each fit the token budget.

    A single message larger than the budget is emitted on its own, truncated.
    """
    budget_tokens = max(1, budget_tokens)
    chunks: list[list[dict]] = []
    current: list[dict] = []
    current_tokens = 0

    for message in messages:
        tokens = estimator(message)
        if tokens > budget_tokens:
            if current:
                chunks.append(current)
                current = []
                current_tokens = 0
            chunks.append([_truncate_message_for_prompt(message, budget_tokens)])
            continue

        if current and current_tokens + tokens > budget_tokens:
            chunks.append(current)
            current = []
            current_tokens = 0

        current.append(message)
        current_tokens += tokens

    if current:
        chunks.append(current)
    return chunks


def _fit_messages_for_prompt(messages: list[dict], budget_tokens: int) -> list[dict]:
    if not messages or _estimate_prompt_messages_tokens(messages) <= budget_tokens:
        return messages

    # Keep the most recent slice; the rest is already represented in the summary.
    chunks = _chunk_messages_for_summary(messages, budget_tokens, _rendered_message_tokens)
    return chunks[-1] if chunks else []


def _plan_summary_calls(
    summary_prompt_template: str,
    compacted_messages: list[dict],
    recent_messages: list[dict],
    previous_summary: str | None,
    budget_tokens: int,
) -> list[tuple[list[dict], list[dict]]]:
    """Plan one or more summary calls so no single prompt overflows the
    compaction model's window.

    Returns ``(compacted_chunk, recent_messages)`` pairs. When everything fits
    a single pair preserving the original compacted/recent split is returned.
    """
    overhead = _estimate_tokens(summary_prompt_template) + _estimate_tokens(previous_summary or '')
    # Leave room for the prompt skeleton and tokenizer drift so the rendered
    # prompt stays under the per-call budget.
    effective = max(1, budget_tokens - overhead - 1000)

    if _estimate_messages_tokens(compacted_messages) + _estimate_prompt_messages_tokens(recent_messages) <= effective:
        return [(compacted_messages, recent_messages)]

    # Keep a slice of the retained messages in the final call so the summary
    # stays anchored, but cap it so it cannot crowd out the compacted history.
    recent_budget = min(_estimate_prompt_messages_tokens(recent_messages), effective // 3)
    chunk_budget = max(1, effective - recent_budget)
    recent_for_last = _fit_messages_for_prompt(recent_messages, recent_budget)

    chunks = _chunk_messages_for_summary(compacted_messages, chunk_budget)
    if not chunks:
        return [(compacted_messages, recent_for_last)]

    return [(chunk, recent_for_last if idx == len(chunks) - 1 else []) for idx, chunk in enumerate(chunks)]


# Fields a chat completion accepts; the rest of what Open WebUI stores per
# message (output, files, usage, meta, ...) would only confuse the model.
_SUMMARY_MESSAGE_FIELDS = ('role', 'content', 'name', 'tool_calls', 'tool_call_id')


def _project_summary_message(message: dict) -> dict:
    """Reduce a stored message to the fields the compaction model should see,
    falling back to the rendered output text when the content is empty."""
    projected = {field: message[field] for field in _SUMMARY_MESSAGE_FIELDS if field in message}
    projected['role'] = message.get('role', 'user')

    content = projected.get('content')
    if content is None or (isinstance(content, str) and not content.strip()):
        fallback = get_content_from_message(message)
        projected['content'] = fallback if fallback else ''

    return projected


async def _build_summary_messages(
    summary_prompt_template: str,
    compacted_messages: list[dict],
    recent_messages: list[dict],
    previous_summary: str | None,
    user,
) -> list[dict]:
    """Build the compaction request: the messages being cut, sent with their
    original roles, followed by a user turn asking the model to summarize them."""
    all_messages = [*compacted_messages, *recent_messages]
    prompt = replace_prompt_variable(summary_prompt_template, get_last_user_message(all_messages) or '')
    prompt = replace_messages_variable(prompt, all_messages)
    # The compacted messages are already above as real messages, so any
    # {{COMPACTED_MESSAGES}} placeholder collapses to nothing.
    prompt = replace_messages_variable(prompt, [], 'COMPACTED_MESSAGES')
    prompt = replace_messages_variable(prompt, recent_messages, 'RECENT_MESSAGES')
    prompt = prompt_variables_template(prompt, {'{{PREVIOUS_SUMMARY}}': previous_summary or ''})
    prompt = await prompt_template(prompt, user)
    return [*map(_project_summary_message, compacted_messages), {'role': 'user', 'content': prompt}]


def _fallback_summary(previous_summary: str | None, messages: list[dict]) -> str:
    parts = [previous_summary] if previous_summary else []
    for message in messages:
        content = get_content_from_message(message)
        if content:
            parts.append(f'- {message.get("role", "unknown")}: {content[:500]}')
    return '\n'.join(parts)[:4000]


async def _generate_summary(
    request,
    user,
    model_id: str,
    models: dict,
    compacted_messages: list[dict],
    recent_messages: list[dict],
    previous_summary: str | None,
    summary_prompt_template: str,
) -> str:
    from open_webui.utils.chat import generate_chat_completion

    if getattr(request.state, 'direct', False) and hasattr(request.state, 'model'):
        models = {**dict(models.items()), request.state.model['id']: request.state.model}

    task_config = await Config.get_many(
        'task.model.params',
        'chat.context_compaction.model',
        'chat.context_compaction.token_cap',
        'chat.context_compaction.token_threshold',
    )
    context_compaction_model = task_config.get('chat.context_compaction.model')
    task_model_id = context_compaction_model if context_compaction_model in models else model_id
    if task_model_id not in models:
        raise ValueError('No available model for context compaction')

    summary_prompt_template = summary_prompt_template.strip() or DEFAULT_CONTEXT_COMPACTION_PROMPT

    # The compaction model has no advertised window in Open WebUI, so reuse the
    # token cap/threshold that bounds the main context as the per-call budget.
    summary_input_budget = (
        _parse_positive_int(task_config.get('chat.context_compaction.token_cap'))
        or _parse_positive_int(task_config.get('chat.context_compaction.token_threshold'))
        or 80000
    )

    task_model_params = task_config.get('task.model.params') or {}
    if not isinstance(task_model_params, dict):
        task_model_params = {}
    task_model_params = {key: value for key, value in task_model_params.items() if value is not None and value != ''}
    task_model_params = task_model_params or {
        'max_tokens': models[task_model_id].get('info', {}).get('params', {}).get('max_tokens', 1000)
    }

    async def run_summary_prompt(summary_messages: list[dict]) -> str:
        payload = {
            'model': task_model_id,
            'messages': summary_messages,
            'stream': False,
            'metadata': {
                **(request.state.metadata if hasattr(request.state, 'metadata') else {}),
                'task': 'context_compaction',
            },
        }
        payload = apply_params_to_form_data(payload, models[task_model_id], task_model_params)
        response = await generate_chat_completion(request, form_data=payload, user=user)
        return _response_text(response).strip()

    plans = _plan_summary_calls(
        summary_prompt_template,
        compacted_messages,
        recent_messages,
        previous_summary,
        summary_input_budget,
    )

    summary = ''
    running_summary = previous_summary
    for compacted_chunk, recent_chunk in plans:
        summary_messages = await _build_summary_messages(
            summary_prompt_template,
            compacted_chunk,
            recent_chunk,
            running_summary,
            user,
        )
        summary = await run_summary_prompt(summary_messages)
        if not summary:
            # Model returned nothing usable; keep the essentials so later chunks
            # still have something to fold into.
            summary = _fallback_summary(running_summary, compacted_chunk)
        running_summary = summary

    if summary:
        return summary
    return _fallback_summary(previous_summary, compacted_messages)


def _response_text(response: Any) -> str:
    if isinstance(response, list) and len(response) == 1:
        response = response[0]

    if isinstance(response, JSONResponse):
        try:
            response = JSONCodec.loads(response.body.decode('utf-8', 'replace'))
        except Exception:
            return ''

    if not isinstance(response, dict):
        return ''

    choices = response.get('choices') or []
    if choices:
        message = choices[0].get('message') or {}
        return message.get('content') or message.get('reasoning_content') or ''

    parts = []
    for item in response.get('output') or []:
        for content in item.get('content') or []:
            if isinstance(content, dict):
                parts.append(content.get('text') or content.get('content') or '')
    return '\n'.join(part for part in parts if part)


def _estimate_messages_tokens(messages: list[dict]) -> int:
    total = 0
    for message in messages:
        total += 4
        content = message.get('content')
        if isinstance(content, list):
            for item in content:
                if not isinstance(item, dict):
                    total += _estimate_tokens(item)
                elif item.get('type') in {'image', 'image_url'}:
                    total += 1000
                else:
                    total += _estimate_tokens(item.get('text') or item.get('content') or item)
        else:
            total += _estimate_tokens(content)

        total += _estimate_tokens(message.get('output'))
        total += _estimate_tokens(message.get('tool_calls'))
        files = message.get('files')
        if files:
            # Inline data is not part of the file tags sent to the model.
            total += _estimate_tokens(BASE64_DATA_URI_RE.sub('', JSONCodec.dumps(files, ensure_ascii=False)))
    return total


def _estimate_tokens(value: Any) -> int:
    if value is None:
        return 0

    if not isinstance(value, str):
        try:
            value = JSONCodec.dumps(value, ensure_ascii=False)
        except Exception:
            value = str(value)

    if not value:
        return 0

    return max(1, len(value) // 4)
