from __future__ import annotations

import logging
import re
from typing import Any

from fastapi.responses import JSONResponse
from open_webui.models.chats import Chats
from open_webui.models.config import Config
from open_webui.utils.chat_id import is_saved_chat_id
from open_webui.utils.json_codec import JSONCodec
from open_webui.utils.misc import get_content_from_message, get_message_list
from open_webui.utils.task import prompt_template, prompt_variables_template

log = logging.getLogger(__name__)

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
    previous_summary: str | None = None,
    prompt_tokens: int | None = None,
) -> tuple[list[dict], str | None, bool]:
    config = await _load_config()
    if not config['enable']:
        return messages, None, False

    system_messages = [messages[0]] if messages and messages[0].get('role') == 'system' else []
    messages = messages[1:] if system_messages else messages

    messages, checkpoint_summary = _apply_latest_summary_checkpoint(messages)
    # Take the summary from the checkpoint (or from the caller / the current
    # system block) instead of metadata.
    previous_summary = checkpoint_summary or previous_summary or existing_conversation_summary(system_messages)
    system_prompt = system_prompt or (get_content_from_message(system_messages[0]) if system_messages else '')
    token_threshold = _resolve_token_threshold(config['token_threshold'], config['token_cap'], metadata)
    # The tool loop knows the provider's real prompt size, which the local
    # estimate can miss (tool schemas, chat template, images); trust it when given.
    over_threshold = _exceeds_token_threshold(messages, system_prompt, previous_summary, token_threshold) or (
        prompt_tokens is not None and prompt_tokens > token_threshold
    )
    if not over_threshold or len(messages) <= 3:
        return [*system_messages, *messages], checkpoint_summary, False

    boundary = _find_compaction_boundary(messages, config['retention_percentage'])
    compacted_messages = messages[:boundary]
    recent_messages = messages[boundary:]
    if not compacted_messages or not recent_messages:
        return [*system_messages, *messages], checkpoint_summary, False

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
            previous_summary,
            config['prompt_template'],
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

    chat_id = metadata.get('chat_id')
    checkpoint_message_id = (
        recent_messages[0].get('id') or metadata.get('user_message_id') or metadata.get('message_id')
    )
    # Only whole-turn user boundaries correspond to persisted chat checkpoints.
    if recent_messages[0].get('role') == 'user' and is_saved_chat_id(chat_id) and checkpoint_message_id:
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

    return [*system_messages, *recent_messages], summary, True


async def compact_chat_branch(request, user, chat: Any, model_id: str, models: dict) -> dict:
    config = await _load_config()
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

    messages, previous_summary = _apply_latest_summary_checkpoint(get_message_list(messages_map, current_id))
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


async def _load_config() -> dict:
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
    chat_data = chat.chat or {}
    history = chat_data.get('history') or {}
    current_id = getattr(chat, 'current_message_id', None) or history.get('currentId')
    if not current_id:
        current_id = chat_data.get('currentId') or chat_data.get('branchPointMessageId')
    if not current_id and isinstance(chat_data.get('messages'), list) and chat_data['messages']:
        current_id = chat_data['messages'][-1].get('id')
    if not current_id:
        return None

    messages_map = await Chats.get_messages_map_by_chat_id(chat.id)
    messages = get_message_list(messages_map or history.get('messages') or {}, current_id)
    if not messages:
        return None

    config = await _load_config()
    if not config['enable']:
        return None

    params = ((chat.chat or {}).get('params') or {}).copy()
    if model_id:
        params['model'] = model_id
    threshold = _resolve_token_threshold(config['token_threshold'], config['token_cap'], {'params': params})
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
    for idx in range(len(messages) - 1, -1, -1):
        message = messages[idx]
        value = message.get('contextSummary') or message.get('context_summary')
        if isinstance(value, str) and value.strip():
            return messages[idx:], value

        marker = next(
            (
                item
                for item in reversed(message.get('output') or [])
                if item.get('type') == 'open_webui:context_compaction'
            ),
            None,
        )
        if not marker:
            continue

        # A tool-loop checkpoint can retain output from an earlier reply.
        for cut_idx in range(idx, -1, -1):
            output = messages[cut_idx].get('output') or []
            start = next(
                (
                    position
                    for position, item in enumerate(output)
                    if item.get('type') == 'function_call' and item.get('call_id') == marker['call_id']
                ),
                None,
            )
            if start is not None:
                while start and output[start - 1].get('type') != 'function_call_output':
                    start -= 1
                return [
                    *messages[max(0, cut_idx - 1) : cut_idx],
                    {
                        **messages[cut_idx],
                        'output': [
                            item for item in output[start:] if item.get('type') != 'open_webui:context_compaction'
                        ],
                    },
                    *messages[cut_idx + 1 :],
                ], marker['summary']

    return messages, None


CONVERSATION_SUMMARY_MARKER = '[CONVERSATION SUMMARY]'


def existing_conversation_summary(messages: list[dict]) -> str | None:
    """Body of the newest ``[CONVERSATION SUMMARY]`` block in the system message."""
    summary = None
    for message in messages:
        if message.get('role') != 'system':
            continue
        content = get_content_from_message(message)
        if not isinstance(content, str):
            continue
        index = content.rfind(CONVERSATION_SUMMARY_MARKER)
        if index != -1:
            summary = content[index + len(CONVERSATION_SUMMARY_MARKER) :].strip() or summary
    return summary


def _exceeds_token_threshold(messages: list[dict], system_prompt: str, summary: str | None, threshold: int) -> bool:
    if threshold <= 0:
        return False

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

    def _last_boundary_at_or_before(boundaries: list[int]) -> int:
        return next((idx for idx in reversed(boundaries) if idx <= target), 0)

    if any(message.get('role') == 'tool' for message in messages):
        # Only tool blocks produced after the task message (the current run) are
        # valid cuts: their anchor always lives in the current output and the
        # task message is the one both the loop and replay re-pin. The first such
        # block is kept so the run stays anchored in the retained context.
        last_user = max((idx for idx, message in enumerate(messages) if message.get('role') == 'user'), default=-1)
        boundaries = [
            idx
            for idx, message in enumerate(messages)
            if idx > last_user and message.get('role') == 'assistant' and message.get('tool_calls')
        ][1:]
        mid_turn = _last_boundary_at_or_before(boundaries)
        if mid_turn:
            return mid_turn
        # No mid-turn cut fits the retention window (e.g. the current turn has
        # too few tool blocks): fall back to the last whole-turn boundary below
        # so the run still compacts. Turn-level cuts carry no tool-call anchor,
        # so callers must not emit a mid-turn output marker for them.
    return _last_boundary_at_or_before(
        [idx for idx, message in enumerate(messages) if message.get('role') == 'user'][1:]
    )


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
    previous_summary: str | None,
    user,
) -> list[dict]:
    """Build the compaction request.

    The messages to summarize are sent as real chat messages; a single trailing
    user turn carries the summary prompt. Only the previous summary is needed in
    the prompt, since the messages being summarized are already above.
    """
    prompt = prompt_variables_template(summary_prompt_template, {'{{PREVIOUS_SUMMARY}}': previous_summary or ''})
    prompt = await prompt_template(prompt, user)
    return [
        *(_project_summary_message(message) for message in compacted_messages),
        {'role': 'user', 'content': prompt},
    ]


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
    previous_summary: str | None,
    summary_prompt_template: str,
) -> str:
    from open_webui.utils.chat import generate_chat_completion

    if getattr(request.state, 'direct', False) and hasattr(request.state, 'model'):
        models = {**dict(models.items()), request.state.model['id']: request.state.model}

    # The global task model parameters are tuned for short, single-purpose tasks
    # (titles, tags, queries); applying them here truncates or warps summaries, so
    # the compaction request is sent with the provider defaults untouched.
    task_config = await Config.get_many('chat.context_compaction.model')
    context_compaction_model = task_config.get('chat.context_compaction.model')
    task_model_id = context_compaction_model if context_compaction_model in models else model_id
    if task_model_id not in models:
        raise ValueError('No available model for context compaction')

    summary_prompt_template = summary_prompt_template.strip() or DEFAULT_CONTEXT_COMPACTION_PROMPT

    summary_messages = await _build_summary_messages(
        summary_prompt_template,
        compacted_messages,
        previous_summary,
        user,
    )
    payload = {
        'model': task_model_id,
        'messages': summary_messages,
        'stream': False,
        'metadata': {
            **(request.state.metadata if hasattr(request.state, 'metadata') else {}),
            'task': 'context_compaction',
        },
    }
    response = await generate_chat_completion(request, form_data=payload, user=user)
    summary = _response_text(response).strip()
    return summary or _fallback_summary(previous_summary, compacted_messages)


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
