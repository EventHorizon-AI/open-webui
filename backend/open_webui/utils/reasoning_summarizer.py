"""
Reasoning summarization task helpers.

Streamed raw chain-of-thought is cut into sizable chunks (English words /
CJK characters as units, double-newline-preferred boundaries with a hard cap)
and summarized on the task model so the user sees compact, titled summaries
instead of the raw wall of text.

Core flow is ported from the Reasoning Summarizer pipe (by EntropyYue):
unit counting, chunk cutting with a hard cap, and the raw-chunk fallback when
the task model is unavailable. Like the other tasks, the output format is a
plain JSON object requested in the prompt and parsed best-effort.

This module only holds stateless helpers; the per-stream state (reasoning
buffer, chunk sequence, in-flight summaries) and the task config resolution
stay at the call sites in ``middleware``, alongside the other tasks.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from open_webui.constants import TASKS
from open_webui.utils.json_codec import JSONCodec
from open_webui.utils.task import replace_prompt_variable

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------

# Ranges treated as "one character = one unit" (hira/kana, hangul, CJK
# ideographs and punctuation, fullwidth forms). Latin words count as one unit.
_CJK_RANGES = (
    (0x3040, 0x30FF),  # hiragana + katakana
    (0x3400, 0x4DBF),  # CJK ext A
    (0x4E00, 0x9FFF),  # CJK unified
    (0xAC00, 0xD7AF),  # hangul syllables
    (0xF900, 0xFAFF),  # CJK compatibility ideographs
    (0x20000, 0x2A6DF),  # CJK ext B
    (0x3000, 0x303F),  # CJK punctuation
    (0xFF00, 0xFF65),  # fullwidth forms
)
_WORD_RE = re.compile(r"[A-Za-z0-9_'’]+")

# Placeholder through which the reasoning chunk enters the prompt, mirroring
# the {{prompt}} variable of the other task templates.
_PROMPT_PLACEHOLDER_RE = re.compile(r'(?i)\{\{prompt(?::(?:start|end|middletruncate):\d+)?\}\}')


def _is_cjk(ch: str) -> bool:
    o = ord(ch)
    return any(lo <= o <= hi for lo, hi in _CJK_RANGES)


def count_units(text: str) -> int:
    """English counts words, CJK counts characters."""
    if not text:
        return 0
    return len(_WORD_RE.findall(text)) + sum(1 for ch in text if _is_cjk(ch))


def prefix_cut_index(text: str, target_units: int) -> int:
    """Return the char index right after ``target_units`` units are reached."""
    if target_units <= 0:
        return 0
    units = 0
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if _is_cjk(ch):
            units += 1
            i += 1
            if units >= target_units:
                return i
        elif ch.isalnum() or ch in "_'’":
            j = i
            while j < n and (text[j].isalnum() or text[j] in "_'’"):
                j += 1
            units += 1
            i = j
            if units >= target_units:
                return i
        else:
            i += 1
    return n


def extract_json(text: str) -> dict[str, Any] | None:
    """Best-effort JSON object extraction (tolerates code fences / prose)."""
    if not text:
        return None
    text = text.strip()
    fence = re.search(r'```(?:json)?\s*(.*?)```', text, re.S | re.I)
    if fence:
        text = fence.group(1).strip()
    start = text.find('{')
    end = text.rfind('}')
    if start != -1 and end != -1 and end > start:
        text = text[start : end + 1]
    try:
        obj = JSONCodec.loads(text)
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def cut_chunk(buffer: str, chunk_size: int, hard_max_units: int, force: bool) -> tuple[str, str] | None:
    """Cut the first ready chunk off ``buffer``; return ``(chunk, remainder)``.

    ``force`` flushes the whole buffer (the tail). Otherwise a chunk is cut at
    the configured size, preferring a double-newline boundary and falling back
    to a hard cap at ``hard_max_units``.
    """
    if not buffer:
        return None
    if force:
        return buffer, ''
    if count_units(buffer) < chunk_size:
        return None

    cut = prefix_cut_index(buffer, chunk_size)
    sep = buffer.find('\n\n', cut)
    if sep != -1:
        end = sep + 2
        return buffer[:end], buffer[end:]

    if count_units(buffer) >= hard_max_units:
        hard = prefix_cut_index(buffer, hard_max_units)
        ws = buffer.rfind(' ', 0, hard)
        if ws <= 0:
            ws = hard
        return buffer[:ws], buffer[ws:].lstrip()
    return None


# ---------------------------------------------------------------------------
# Task model response parsing
# ---------------------------------------------------------------------------


def _response_text(response: Any) -> str:
    """Extract the plain content from a non-streaming completion response."""
    if isinstance(response, list) and len(response) == 1:
        response = response[0]

    if hasattr(response, 'body'):
        try:
            response = JSONCodec.loads(response.body.decode('utf-8', 'replace'))
        except Exception:
            return ''

    if not isinstance(response, dict):
        return ''

    choices = response.get('choices') or []
    if choices:
        return (choices[0].get('message') or {}).get('content') or ''

    parts = []
    for item in response.get('output') or []:
        content_items = item.get('content') or []
        if isinstance(content_items, dict):
            content_items = [content_items]
        for content in content_items:
            if isinstance(content, dict):
                parts.append(content.get('text') or '')
    return '\n'.join(part for part in parts if part)


def render_summary_prompt(template: str, chunk_text: str) -> str:
    """Embed the reasoning chunk into the prompt template.

    Like the other tasks, the rendered template is sent as the user message
    itself; the chunk enters through a ``{{prompt}}`` placeholder. Templates
    missing the placeholder get the chunk appended so it cannot be lost.
    """
    if _PROMPT_PLACEHOLDER_RE.search(template):
        return replace_prompt_variable(template, chunk_text)
    log.warning(
        "the reasoning summary prompt template does not contain a '{{prompt}}' placeholder; "
        'appending the raw chunk to the prompt'
    )
    return f'{template}\n\n{chunk_text}'


def build_summary_payload(model_id: str, content: str) -> dict[str, Any]:
    """Build the non-streaming completion payload for one chunk."""
    return {
        'model': model_id,
        'messages': [{'role': 'user', 'content': content}],
        'stream': False,
        # Minimal metadata, following `context_compaction`'s internal
        # sub-call convention: tag the task so middleware hooks (and the
        # summarizer itself) skip it. Chat routing metadata from the main
        # request is merged by generate_chat_completion anyway.
        'metadata': {
            'task': str(TASKS.REASONING_SUMMARY),
        },
    }


async def generate_reasoning_summary(
    request,
    user,
    models: dict,
    task_model_id: str,
    task_model_params: dict,
    template: str,
    chunk_text: str,
) -> str:
    """Run one generation attempt on the task model; return plain text.

    Applies the global task-model parameters (max_tokens, temperature, ...)
    exactly like the title/tags/queries tasks do.
    """
    from open_webui.routers.tasks import apply_task_model_params
    from open_webui.utils.chat import generate_chat_completion

    payload = build_summary_payload(
        task_model_id,
        render_summary_prompt(template, chunk_text),
    )

    try:
        payload = apply_task_model_params(payload, models, task_model_id, task_model_params or None)
    except Exception as e:
        log.debug('failed to apply task model params: %s', e)

    response = await generate_chat_completion(request, form_data=payload, user=user)
    return _response_text(response)


def parse_summary_response(content: str) -> dict[str, Any] | None:
    """Extract the ``{title, summary}`` JSON object from task model output.

    Like the other tasks, the model is only asked for a raw JSON object in
    prose and the parser tolerates code fences / wrapper text.
    """
    obj = extract_json(content)
    if obj is None or 'title' not in obj or 'summary' not in obj:
        return None
    return obj


async def summarize_reasoning(
    request,
    user,
    models: dict,
    task_model_id: str,
    task_model_params: dict,
    template: str,
    chunk_text: str,
) -> dict[str, Any] | None:
    """Run one chunk through the task model, once.

    Failed attempts (request errors or unparsable output) degrade to ``None``
    so callers fall back to the raw chunk.
    """
    try:
        content = await generate_reasoning_summary(
            request,
            user,
            models,
            task_model_id,
            task_model_params,
            template,
            chunk_text,
        )
    except Exception as e:
        log.debug('reasoning summary task failed: %s', e)
        return None

    result = parse_summary_response(content)
    if result is None:
        log.debug('reasoning summary task JSON parse failed')
    return result


# ---------------------------------------------------------------------------
# Chunk results
# ---------------------------------------------------------------------------


def format_summary_body(result: dict | None, chunk_text: str) -> str:
    """Format one summary part the way the pipe formatted summaries.

    A success renders as ``**{title}**\\n{summary}`` (title omitted when
    empty). Chunks the task model could not summarize return the raw chunk
    text so callers can fall back to it.
    """
    if result is not None:
        title = str(result.get('title') or '').strip()
        summary = str(result.get('summary') or '').strip()
        text = f'**{title}**\n{summary}' if title else summary
        if not text:
            text = chunk_text
    else:
        text = chunk_text
    return text or ''


def chunk_summary_result(chunk_text: str, result: dict | None) -> tuple[str, str, bool]:
    """Pack one finished chunk as ``(chunk_text, body, summarized)``.

    ``body`` is the markdown that goes into the reasoning item's ``summary``
    field ('' when nothing should be stored). ``result is None`` means the
    task model produced no title+summary, so the raw chunk text is the body,
    keeping it visible in the fallback path.
    """
    return chunk_text, format_summary_body(result, chunk_text), result is not None


async def await_chunk_task(task: asyncio.Task) -> tuple[str, str, bool] | None:
    """Join one summary task; failures degrade to ``None`` (raw fallback)."""
    try:
        return await task
    except Exception as e:
        log.debug('reasoning summary chunk task failed: %s', e)
        return None
