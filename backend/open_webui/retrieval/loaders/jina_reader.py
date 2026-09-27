import logging
from typing import Iterator, List, Optional, Union

import requests
from langchain_core.document_loaders import BaseLoader
from langchain_core.documents import Document

log = logging.getLogger(__name__)

DEFAULT_JINA_READER_BASE_URL = 'https://r.jina.ai'


class JinaReaderLoader(BaseLoader):
    """Load web pages as clean Markdown using a Jina Reader (r.jina.ai-compatible) endpoint.

    Jina Reader takes the target URL in the path (``GET {base}/{url}``) or as a form
    field (``POST {base}/`` with ``url=``), so it is not compatible with the generic
    JSON "External" web loader. Works with the hosted reader as well as a self-hosted
    ``ghcr.io/jina-ai/reader:oss`` instance (which needs no API key).

    Args:
        urls: URL or list of URLs to read.
        base_url: Base URL of the reader instance, e.g. ``https://r.jina.ai`` or
            ``http://192.168.1.134:8011``.
        api_key: Optional API key, only needed for the hosted reader.
        respond_with: Optional ``x-respond-with`` value (markdown, frontmatter, html, ...).
        timeout: Optional request timeout in seconds.
        verify_ssl: Whether to verify the reader endpoint's TLS certificate.
        continue_on_failure: Whether to continue if reading a URL fails.
    """

    def __init__(
        self,
        urls: Union[str, List[str]],
        base_url: str = DEFAULT_JINA_READER_BASE_URL,
        api_key: Optional[str] = None,
        respond_with: Optional[str] = None,
        timeout: Optional[int] = None,
        verify_ssl: bool = True,
        continue_on_failure: bool = True,
    ) -> None:
        if not urls:
            raise ValueError('At least one URL must be provided.')

        self.urls = urls if isinstance(urls, list) else [urls]
        self.base_url = (base_url or DEFAULT_JINA_READER_BASE_URL).rstrip('/')
        self.api_key = api_key
        self.respond_with = (respond_with or '').strip().lower() or None
        self.timeout = timeout
        self.verify_ssl = verify_ssl
        self.continue_on_failure = continue_on_failure

    def _headers(self) -> dict:
        headers = {'Accept': 'text/plain'}
        if self.api_key:
            headers['Authorization'] = f'Bearer {self.api_key}'
        if self.respond_with:
            headers['x-respond-with'] = self.respond_with
        return headers

    def _extract_content(self, response: requests.Response) -> str:
        content_type = response.headers.get('Content-Type', '')
        if 'application/json' in content_type:
            data = response.json()
            if isinstance(data, dict):
                data = data.get('data', data)
            if isinstance(data, dict):
                return data.get('content') or data.get('markdown') or ''
            if isinstance(data, str):
                return data
        return response.text

    def _fetch(self, url: str) -> str:
        headers = self._headers()
        response = requests.get(
            f'{self.base_url}/{url}',
            headers=headers,
            timeout=self.timeout,
            verify=self.verify_ssl,
        )
        # Some reader deployments reject long or complex URLs in the path; retry
        # through the form-encoded POST contract, which Jina Reader also supports.
        if 400 <= response.status_code < 500:
            log.debug(
                'Jina Reader GET returned %s for %s; retrying with POST',
                response.status_code,
                url,
            )
            response = requests.post(
                f'{self.base_url}/',
                headers=headers,
                data={'url': url},
                timeout=self.timeout,
                verify=self.verify_ssl,
            )
        response.raise_for_status()
        return self._extract_content(response)

    @staticmethod
    def _metadata(url: str, content: str) -> dict:
        metadata = {'source': url}
        for line in content.splitlines()[:5]:
            if line.startswith('Title:'):
                title = line[len('Title:') :].strip()
                if title:
                    metadata['title'] = title
                break
            if not line.strip():
                break
        return metadata

    def lazy_load(self) -> Iterator[Document]:
        for url in self.urls:
            try:
                content = self._fetch(url)
                if not content:
                    log.warning(f'No content returned by Jina Reader for {url}')
                    continue
                yield Document(
                    page_content=content,
                    metadata=self._metadata(url, content),
                )
            except Exception as e:
                if self.continue_on_failure:
                    log.error(f'Error reading {url} with Jina Reader: {e}')
                    continue
                raise
