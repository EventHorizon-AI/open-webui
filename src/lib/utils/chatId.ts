const TEMPORARY_CHAT_ID_PREFIX = 'temporary:';
const LEGACY_TEMPORARY_CHAT_ID_PREFIX = 'local:'; // Legacy temporary chat prefix.
const CHANNEL_CHAT_ID_PREFIX = 'channel:';

export const createTemporaryChatId = (sessionId: string | undefined) =>
	`${TEMPORARY_CHAT_ID_PREFIX}${sessionId}`;

export const isTemporaryChatId = (chatId: string | null | undefined) =>
	!!chatId &&
	(chatId.startsWith(TEMPORARY_CHAT_ID_PREFIX) ||
		chatId.startsWith(LEGACY_TEMPORARY_CHAT_ID_PREFIX));

export const isSavedChatId = (chatId: string | null | undefined) =>
	!!chatId && !isTemporaryChatId(chatId) && !chatId.startsWith(CHANNEL_CHAT_ID_PREFIX);

/**
 * The chat id currently shown in the browser URL (`/c/<id>`), or `''` when not
 * on a chat route.
 *
 * The app rewrites the URL with `history.replaceState` in several places
 * (starting a chat from the home page, resetting to a new chat, ...), which
 * SvelteKit does not pick up, so `$page.params.id` can lag behind what the user
 * actually sees. Reading the real location keeps that check honest.
 */
export const getChatIdFromLocation = (): string => {
	if (typeof window === 'undefined') return '';

	const match = window.location.pathname.match(/\/c\/([^/?#]+)/);
	return match ? decodeURIComponent(match[1]) : '';
};
