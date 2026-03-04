// ==UserScript==
// @name         Kivra - Ladda ner allt
// @namespace    oscar
// @version      0.1
// @description  Lägg till menyalternativ för att hämta alla brev för aktuell mottagare
// @match        https://inbox.kivra.com/user/*
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        unsafeWindow
// @connect      app.api.kivra.com
// ==/UserScript==

(function () {
	'use strict';

	const EXPECTED_PATH = /^\/user\/([^/]+)\/inbox\/?$/;
	const USER_ID_PATH = /^\/user\/([^/]+)/;
	const POLL_INTERVAL_MS = 200;
	const POLL_TIMEOUT_MS = 8000;
	const RESUME_KEY = 'kivra-download-resume';
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const textEquals = (node, value) => node?.textContent?.trim() === value;
	const firstText = (node, selector) => node?.querySelector(selector)?.textContent?.trim();
	const looksLikeToken = (val) => /^[A-Za-z0-9._-]{20,}$/.test(val || '');
	const pageFetch = (...args) => unsafeWindow.fetch(...args);

	const extractTokenFromString = (str) => {
		if (!str || typeof str !== 'string') return null;
		const direct = looksLikeToken(str) ? str : null;
		const m1 = str.match(/token[:=]\s*["']?([A-Za-z0-9._-]{20,})/i);
		const m2 = str.match(/bearer\s+([A-Za-z0-9._-]{20,})/i);
		return direct || m1?.[1] || m2?.[1] || null;
	};

	const extractTokenFromJson = (value) => {
		const visit = (node) => {
			if (!node) return null;
			if (typeof node === 'string') return extractTokenFromString(node);
			if (Array.isArray(node)) {
				for (const item of node) {
					const found = visit(item);
					if (found) return found;
				}
				return null;
			}
			if (typeof node === 'object') {
				for (const key of Object.keys(node)) {
					const val = node[key];
					const k = key.toLowerCase();
					const maybe =
						(k.includes('token') || k.includes('access'))
							? extractTokenFromString(String(val))
							: null;
					if (maybe) return maybe;
					const deeper = visit(val);
					if (deeper) return deeper;
				}
			}
			return null;
		};

		try {
			const parsed = typeof value === 'string' ? JSON.parse(value) : value;
			return visit(parsed);
		} catch {
			return null;
		}
	};

	const extractTokenFromKvSession = () => {
		const raw = sessionStorage.getItem('kv.session');
		if (!raw) return null;
		const token = extractTokenFromJson(raw) || extractTokenFromString(raw);
		return token || null;
	};

	const findTokenInStorage = (storage) => {
		const rejected = [];
		for (let i = 0; i < storage.length; i += 1) {
			const key = storage.key(i);
			const rawVal = storage.getItem(key);
			if (typeof rawVal !== 'string') continue;

			const tokenMaybe =
				extractTokenFromString(rawVal) ||
				extractTokenFromJson(rawVal) ||
				(key?.toLowerCase().includes('token') && extractTokenFromString(rawVal));

			if (tokenMaybe) return tokenMaybe;

			if (key?.toLowerCase().includes('token') || key?.toLowerCase().includes('session')) {
				rejected.push({ key, val: rawVal.slice(0, 80) + (rawVal.length > 80 ? '…' : '') });
			}
		}
		if (rejected.length) {
			console.warn('Token/session candidates that were rejected:', rejected);
		}
		return null;
	};

	const pickBestToken = (tokens) => {
		if (!tokens.length) return null;
		// Prefer the longest; tie-breaker: earliest
		return tokens.slice().sort((a, b) => b.length - a.length)[0];
	};

	const getAuthToken = () => {
		const candidates = [];

		const kvSessionToken = extractTokenFromKvSession();
		if (kvSessionToken) candidates.push(kvSessionToken);

		const cookieMatch =
			document.cookie.match(/(?:^|; )token=([^;]+)/)?.[1] ||
			document.cookie.match(/(?:^|; )auth_token=([^;]+)/)?.[1] ||
			document.cookie.match(/(?:^|; )kivra_token=([^;]+)/)?.[1] ||
			extractTokenFromString(document.cookie);
		if (cookieMatch) candidates.push(cookieMatch);

		const lsToken =
			localStorage.getItem('token') ||
			localStorage.getItem('auth_token') ||
			localStorage.getItem('kivra_token') ||
			findTokenInStorage(localStorage);
		if (lsToken) candidates.push(lsToken);

		const ssToken =
			sessionStorage.getItem('token') ||
			sessionStorage.getItem('auth_token') ||
			sessionStorage.getItem('kivra_token') ||
			findTokenInStorage(sessionStorage);
		if (ssToken) candidates.push(ssToken);

		const token = pickBestToken(candidates);
		if (!token) {
			console.warn('Kunde inte hitta auth-token i cookies/localStorage/sessionStorage.');
			console.warn('Cookies:', document.cookie.split(';').map((c) => c.trim().split('=')[0]));
			console.warn(
				'LocalStorage keys:',
				Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
			);
			console.warn(
				'SessionStorage keys:',
				Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i))
			);
		}
		return token;
	};

	const parseUrl = () => {
		const url = new URL(window.location.href);
		const idMatch = url.pathname.match(USER_ID_PATH);
		return {
			url,
			userId: idMatch ? idMatch[1] : null,
			onInbox: EXPECTED_PATH.test(url.pathname),
		};
	};

	const goToInbox = (userId, currentUrl) => {
		const target = `${currentUrl.origin}/user/${userId}/inbox`;
		window.location.href = target;
	};

	const waitForElement = async (getter) => {
		const deadline = Date.now() + POLL_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const el = getter();
			if (el) return el;
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
		}
		return null;
	};

	const scrollToBottom = () => {
		try {
			window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
		} catch {
			window.scrollTo(0, document.body.scrollHeight);
		}
	};

	const locateContentElements = async () => {
		const main = await waitForElement(() => document.getElementById('main'));
		if (!main) {
			console.warn('Hittar inte #main efter väntan.');
			return { main: null, contentList: null, showMore: null };
		}

		const contentList = await waitForElement(() =>
			main.querySelector('[data-test-id="content-list"]')
		);
		if (!contentList) {
			console.warn('Hittar inte content-list i #main.');
			return { main, contentList: null, showMore: null };
		}

		const showMoreButton = contentList.querySelector('[data-component-type="show-more"]>button');
		if (!showMoreButton) {
			console.warn('Hittar inte show-more i content-list.');
		}

		console.log('Kivra: hittade element', { main, contentList, showMore: showMoreButton });
		return { main, contentList, showMore: showMoreButton };
	};

	const clickShowMoreUntilHidden = async (showMoreButton, aborted = () => false) => {
		if (!showMoreButton) return;
		let clicks = 0;
		while (!aborted() && showMoreButton.offsetParent !== null) {
			showMoreButton.click();
			scrollToBottom();
			clicks += 1;
			await sleep(250);
		}
		console.log(`Kivra: show-more dold efter ${clicks} klick.`);
	};

	const ensureAllSectionsLoaded = async (contentList) => {
		let lastCount = 0;
		let stableRounds = 0;
		for (let i = 0; i < 40; i += 1) {
			scrollToBottom();
			await sleep(300);
			const count = contentList.querySelectorAll(':scope > section').length;
			if (count === lastCount) {
				stableRounds += 1;
				if (stableRounds >= 3) break; // ~1s stable
			} else {
				stableRounds = 0;
				lastCount = count;
			}
		}
		console.log('Kivra: sektioner laddade', contentList.querySelectorAll(':scope > section').length);
	};

	let currentRunId = 0;
	const loadAllLetters = async (userId) => {
		const runId = ++currentRunId;
		const startPath = window.location.pathname;
		const aborted = () => runId !== currentRunId || window.location.pathname !== startPath;

		const downloaded = loadDownloadedSet(userId);
		const mode = chooseDownloadMode(userId, downloaded.size);
		if (mode === 'cancel') return;

		const { contentList, showMore } = await locateContentElements();
		if (aborted()) return;
		await clickShowMoreUntilHidden(showMore, aborted);
		if (aborted() || !contentList) return;
		await ensureAllSectionsLoaded(contentList);
		if (aborted()) return;
		await inspectFirstSection(contentList, userId, mode, downloaded);
	};

	const inspectFirstSection = async (contentList, userId, mode, downloaded) => {
		let processed = 0;
		let okCount = 0;
		let skippedExisting = 0;
		let metaFail = 0;
		let downloadFail = 0;
		let tokenFail = 0;

		const items = Array.from(contentList.querySelectorAll('[data-test-id^="content-list-item-"]'));
		for (const item of items) {
			const fileId = extractFileId(item);
			if (!fileId) {
				console.warn('Kunde inte läsa fileId från item.', item);
				continue;
			}

			const token = getAuthToken();
			if (!token) {
				console.warn('Hittar ingen auth-token; kan inte hämta metadata.');
				tokenFail += 1;
				continue;
			}

			if (mode === 'new' && downloaded.has(fileId)) {
				console.log('Hoppar över redan nedladdad fil', fileId);
				skippedExisting += 1;
				continue;
			}

			processed += 1;

			const meta = await fetchMetadata({ userId, fileId, token, fileIdForLog: fileId });
			if (meta) {
				const ok = await fetchFileAndDownload({ userId, fileId, meta, token });
				if (ok) {
					downloaded.add(fileId);
					saveDownloadedSet(userId, downloaded);
					okCount += 1;
				} else {
					downloadFail += 1;
				}
			} else {
				metaFail += 1;
			}
			console.log('Kivra: hämtade metadata för', fileId);
			// continue to next to catch remaining files
		}

		console.log(
			`Kivra sammanfattning: bearbetade=${processed}, nedladdade=${okCount}, redan_nedladdade=${skippedExisting}, meta_fail=${metaFail}, download_fail=${downloadFail}, token_fail=${tokenFail}`
		);
	};

	const extractFileId = (node) => {
		const fromAttr = node.getAttribute('data-test-id');
		const attrMatch = fromAttr?.match(/content-list-item-([^-]+)$/);
		if (attrMatch) return attrMatch[1];
		const link = node.querySelector('a[href*="/content/"]');
		if (!link) return null;
		const match = link.getAttribute('href')?.match(/content\/([^/?#]+)/);
		return match ? match[1] : null;
	};

	const fetchMetadata = async ({ userId, fileId, token, fileIdForLog }) => {
		const url = `https://app.api.kivra.com/v3/user/${userId}/content/${fileId}`;

		// Use GM_xmlhttpRequest to bypass Tampermonkey referrer stripping
		return new Promise((resolve) => {
			GM_xmlhttpRequest({
				method: 'GET',
				url,
				headers: {
					Accept: '*/*',
					'Accept-Language': 'sv,en-US;q=0.9,en;q=0.8,es;q=0.7',
					Authorization: `token ${token}`,
					Origin: 'https://inbox.kivra.com',
					Referer: 'https://inbox.kivra.com/',
				},
				withCredentials: true,
				onload: (res) => {
			console.log('GMX status', res.status, res.responseHeaders);
			if (res.status < 200 || res.status >= 300) {
				console.warn('GET meta misslyckades', res.status, 'fileId=', fileIdForLog || fileId, res.responseText);
				resolve(null);
				return;
			}
					try {
						const meta = JSON.parse(res.responseText);
						console.log('Kivra: metadata', meta);
						resolve(meta);
					} catch (e) {
						console.error('Kunde inte parsa metadata', e, res.responseText);
						resolve(null);
					}
				},
				onerror: (err) => {
					console.error('Fel vid GET meta', err);
					resolve(null);
				},
			});
		});
	};

	const fetchFileAndDownload = async ({ userId, fileId, meta, token }) => {
		const filePart = getFirstFilePart(meta);
		const fileKey = filePart?.key;
		const fileName = filePart?.name || formatFileName(meta, fileId);
		if (!fileKey) {
			console.warn('Meta saknar parts/active_parts key, avbryter filhämtning.', meta);
			return false;
		}

		const rawUrl = `https://app.api.kivra.com/v1/user/${userId}/content/${fileId}/file/${fileKey}/raw`;

		return new Promise((resolve) => {
			GM_xmlhttpRequest({
				method: 'GET',
				url: rawUrl,
				headers: {
					Authorization: `token ${token}`,
					Origin: 'https://inbox.kivra.com',
					Referer: 'https://inbox.kivra.com/',
				},
				withCredentials: true,
				responseType: 'arraybuffer',
				onload: (res) => {
					console.log('GMX file status', res.status, res.responseHeaders);
					if (res.status < 200 || res.status >= 300) {
						console.warn('Filhämtning misslyckades', res.status, 'fileId=', fileId);
						resolve(null);
						return;
					}
					const contentType =
						(res.responseHeaders.match(/content-type:\s*([^\r\n]+)/i)?.[1] || '').trim() ||
						'application/pdf';

					let blob;
					if (res.response instanceof ArrayBuffer) {
						blob = new Blob([new Uint8Array(res.response)], { type: contentType });
					} else if (typeof res.responseText === 'string' && res.responseText.startsWith('data:')) {
						blob = dataUrlToBlob(res.responseText);
					} else {
						console.warn('Oväntat filformat, använder tom blob.');
						blob = new Blob([], { type: contentType });
					}

					const objectUrl = URL.createObjectURL(blob);
					void downloadWithGM(objectUrl, fileName).then((ok) => {
						URL.revokeObjectURL(objectUrl);
						resolve(ok);
					});
				},
				onerror: (err) => {
					console.error('Fel vid filhämtning', err);
					resolve(false);
				},
			});
		});
	};

	const formatFileName = (meta, fileId) => {
		const sender = meta?.sender_name || 'Okänd avsändare';
		const subject = meta?.subject || 'Okänt ämne';
		const date = (meta?.received_at || '').slice(0, 10) || 'okänt-datum';
		const receiver = meta?.receiver_name || 'Okänd mottagare';

		const parts = [sender, subject, date, receiver]
			.map((p) => p.trim())
			.filter(Boolean);

		const base = parts.join(' - ') || fileId || 'kivra-brev';
		const safe = base.replace(/[\\/*?"<>:|]/g, '_').slice(0, 120);
		return safe.endsWith('.pdf') ? safe : `${safe}.pdf`;
	};

	const getFirstFilePart = (meta) => {
		// Prefer any part that has a downloadable key; skip HTML bodies
		const fromParts =
			Array.isArray(meta?.parts) &&
			meta.parts.find((p) => p && typeof p === 'object' && p.key);
		if (fromParts) return fromParts;

		const fromActive =
			Array.isArray(meta?.active_parts) &&
			meta.active_parts.find((p) => p && typeof p === 'object' && p.key);
		if (fromActive) return fromActive;

		return null;
	};

	const downloadWithGM = (url, name) =>
		new Promise((resolve) => {
			GM_download({
				url,
				name,
				saveAs: false,
				onload: () => resolve(true),
				onerror: (err) => {
					console.warn('GM_download error', err);
					resolve(false);
				},
				ontimeout: () => resolve(false),
				onabort: () => resolve(false),
			});
		});

	const loadDownloadedSet = (userId) => {
		try {
			const raw = localStorage.getItem(`kivra_downloads_${userId}`);
			if (!raw) return new Set();
			const arr = JSON.parse(raw);
			return new Set(Array.isArray(arr) ? arr : []);
		} catch {
			return new Set();
		}
	};

	const saveDownloadedSet = (userId, set) => {
		try {
			localStorage.setItem(`kivra_downloads_${userId}`, JSON.stringify(Array.from(set)));
		} catch (e) {
			console.warn('Kunde inte spara nedladdningslista', e);
		}
	};

	const chooseDownloadMode = (userId, previousCount) => {
		if (!previousCount) return 'all';
		const input = window.prompt(
			`Det finns ${previousCount} tidigare nedladdade filer för denna mottagare.\n` +
				'Skriv 1 för att hämta bara nya\n' +
				'Skriv 2 för att hämta alla\n' +
				'Skriv 3 för att avbryta',
			'1'
		);
		if (input === null) return 'cancel';
		const trimmed = input.trim();
		if (trimmed === '1') return 'new';
		if (trimmed === '2') return 'all';
		if (trimmed === '3') return 'cancel';
		alert('Ogiltigt val. Avbryter.');
		return 'cancel';
	};

	const dataUrlToBlob = (dataUrl) => {
		if (!dataUrl.startsWith('data:')) {
			console.warn('Förväntade data:-URL men fick något annat.');
			return new Blob([]);
		}
		const [meta, base64] = dataUrl.split(',');
		const mimeMatch = meta.match(/data:([^;]+)/);
		const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
		const binary = atob(base64);
		const len = binary.length;
		const bytes = new Uint8Array(len);
		for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
		return new Blob([bytes], { type: mime });
	};

	const suggestFileName = (section) => {
		// Try common title locations; fallback to timestamp-based name
		const title =
			firstText(section, 'h3') ||
			firstText(section, '[data-test-id="mail-title"]') ||
			firstText(section, '[role="heading"]');

		if (title) {
			const safe = title.replace(/[\\/*?"<>:|]/g, '_').slice(0, 80);
			return `${safe}.pdf`;
		}

		return `kivra-brev-${Date.now()}.pdf`;
	};

	const handleMenuClick = () => {
		const { url, userId, onInbox } = parseUrl();

		if (!userId) {
			alert('Kunde inte hitta mottagar-ID i URL:en. Gå till en mottagares sida och försök igen.');
			return;
		}

		if (!onInbox) {
			sessionStorage.setItem(RESUME_KEY, '1');
			goToInbox(userId, url);
			return;
		}

		// Already on inbox: run directly and clear any stale resume flag
		sessionStorage.removeItem(RESUME_KEY);
		void loadAllLetters(userId);
	};

	GM_registerMenuCommand('Ladda ner alla brev för aktuell mottagare', handleMenuClick);

	const maybeResumeAfterRedirect = () => {
		const { onInbox } = parseUrl();
		if (!onInbox) return;
		if (sessionStorage.getItem(RESUME_KEY) !== '1') return;
		sessionStorage.removeItem(RESUME_KEY);
		const { userId } = parseUrl();
		if (!userId) return;
		void loadAllLetters(userId);
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', maybeResumeAfterRedirect, { once: true });
	} else {
		void maybeResumeAfterRedirect();
	}
})();
