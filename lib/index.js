/**
 * Baidu Qianfan web search provider for the dsh web seam (`ctx.web`).
 *
 * Registers a `WebSearchProvider` under the stable id `baidu` that calls the
 * Baidu Qianfan AI search endpoint (`https://qianfan.baidubce.com/v2/ai_search/web_search`).
 * With `web.searchProvider: baidu`, the built-in `web_search` tool (mounted by
 * the `standard` agent preset) executes through Baidu instead of the DeepSeek
 * route — a drop-in substitute when `DEEPSEEK_API_KEY` is not configured or the
 * default provider is otherwise unavailable.
 *
 * The provider mirrors the DeepSeek reference implementation's contracts: a
 * cheap no-network `available()`, credential resolution through the credentials
 * service with a launch-environment fallback, stable `WebError` codes
 * (`WEB_PROVIDER_CREDENTIAL_MISSING`, `WEB_PROVIDER_ERROR`, `WEB_ABORTED`),
 * and a secret-free request event recorded on the session log before dispatch.
 * The event type is plugin-private, so it is appended with the envelope's
 * `ignorable` marker: a reader that does not know `web/baidu-search-request`
 * skips the record instead of refusing the whole session log (the request is
 * informational — reconstruction only needs the surrounding `tool/call` /
 * `tool/result` events).
 * The wire format is provider-private and does not use `ctx.llm`.
 * @module dsh-web-search-baidu
 */
import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { WebError } from '@deepseek-ai/dsh-web';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-baidu';
/** The web seam this provider registers into. */
export const inject = ['web'];

/** Stable id this provider registers under on `ctx.web`. */
export const BAIDU_PROVIDER_ID = 'baidu';
/** Default endpoint: Baidu Qianfan AI search, no path is appended. */
export const BAIDU_DEFAULT_BASE_URL = 'https://qianfan.baidubce.com/v2/ai_search/web_search';
/** Default environment variable naming the Baidu Qianfan API key. */
export const DEFAULT_API_KEY_ENV = 'BAIDU_QIANFAN_API_KEY';
/** Default `search_source` value for the AI search payload. */
export const DEFAULT_SEARCH_SOURCE = 'baidu_search_v2';
/** Default `search_recency_filter` value (the payload field is optional). */
export const DEFAULT_SEARCH_RECENCY_FILTER = 'year';
/** Default resource types sent as `resource_type_filter` (Baidu caps `top_k` at 20). */
export const DEFAULT_RESOURCE_TYPES = [{ type: 'web', top_k: 20 }];
/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness-baidu-search/0.1.0';

/**
 * Map a Baidu AI search response to a normalized search result. Walks
 * `references[]` (each item carries `title`, `content`, `url`) into citeable
 * sources, deduping by `url`; a top-level non-empty string `answer` becomes the
 * optional provider-generated `content`. The web service owns the final
 * `maxResults` truncation, so `truncated` is always `false` here.
 *
 * @param response - the parsed Baidu response body.
 * @returns the normalized result; empty `sources` when the API returned no references.
 */
export function mapBaiduResponse(response) {
	const refs = Array.isArray(response?.references) ? response.references : [];
	const sources = [];
	const seen = new Set();
	for (const ref of refs) {
		if (ref === null || typeof ref !== 'object') continue;
		const url = typeof ref.url === 'string' ? ref.url : '';
		if (url.length === 0 || seen.has(url)) continue;
		seen.add(url);
		const title = typeof ref.title === 'string' && ref.title.length > 0 ? ref.title : undefined;
		const snippet = typeof ref.content === 'string' && ref.content.length > 0 ? ref.content : undefined;
		sources.push({
			url,
			...(title !== undefined ? { title } : {}),
			...(snippet !== undefined ? { snippet } : {})
		});
	}
	const answer = typeof response?.answer === 'string' && response.answer.length > 0 ? response.answer : undefined;
	return {
		...(answer !== undefined ? { content: answer } : {}),
		sources,
		truncated: false
	};
}

/**
 * The Baidu-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`.
 */
export class BaiduSearchProvider {
	id = BAIDU_PROVIDER_ID;

	/**
	 * @param resolveOptions - the options for the NEXT operation, snapshotted
	 * once at each operation's entry so one search never mixes two config
	 * sources. A thunk rather than a value because the plugin's settings section
	 * can change between searches, and re-registering the provider to carry a new
	 * endpoint would make the seam's selection observable to the user as a flicker.
	 */
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions;
	}

	/** Cheap local usability check; must not make network calls. */
	available() {
		const options = this.resolveOptions();
		return (options.apiKey?.length > 0 || options.resolveApiKey !== undefined) && URL.canParse(options.baseURL);
	}

	/** Run one Baidu AI search; honor `signal` for cancellation. */
	async search(request, signal) {
		const options = this.resolveOptions();
		const apiKey = await this.apiKey(options, signal);
		throwIfSearchAborted(signal);
		// Normalize the payload tunables at the operation boundary so a caller
		// snapshot that omitted them (or a settings section mid-update) still
		// dispatches with the package defaults.
		const searchSource = options.searchSource ?? DEFAULT_SEARCH_SOURCE;
		const resourceTypes = options.resourceTypes ?? DEFAULT_RESOURCE_TYPES;
		const searchRecencyFilter = options.searchRecencyFilter ?? DEFAULT_SEARCH_RECENCY_FILTER;
		// The exact payload of the Baidu Qianfan `ai_search/web_search` endpoint.
		const body = {
			messages: [
				{
					content: request.query,
					role: 'user'
				}
			],
			search_source: searchSource,
			resource_type_filter: resourceTypes.map((rt) => (
				rt.top_k !== undefined ? { type: rt.type, top_k: rt.top_k } : { type: rt.type }
			)),
			...searchRecencyFilter.length > 0 ? { search_recency_filter: searchRecencyFilter } : {}
		};
		options.recordRequest?.({
			endpoint: options.baseURL,
			body
		});
		throwIfSearchAborted(signal);
		let response;
		try {
			response = await fetch(options.baseURL, {
				method: 'POST',
				redirect: 'error',
				headers: {
					authorization: `Bearer ${apiKey}`,
					'content-type': 'application/json',
					accept: 'application/json',
					'user-agent': USER_AGENT
				},
				body: JSON.stringify(body),
				...signal !== undefined ? { signal } : {}
			});
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`Baidu search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
		}
		if (!response.ok) {
			let message = `Baidu API error (HTTP ${response.status})`;
			try {
				const parsed = await response.json();
				const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message;
				if (detail !== undefined && detail.length > 0) message = detail;
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			}
			throw new WebError(message, 'WEB_PROVIDER_ERROR');
		}
		try {
			return mapBaiduResponse(await response.json());
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			if (error instanceof WebError) throw error;
			throw new WebError(`Baidu returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
		}
	}

	/**
	 * Resolve one operation's credential without retaining it on the provider.
	 * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one source.
	 * @param signal - abort signal for the surrounding search.
	 * @returns the resolved key.
	 */
	async apiKey(options, signal) {
		throwIfSearchAborted(signal);
		if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey;
		let resolved;
		try {
			resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`Baidu search credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
		}
		if (resolved !== undefined && resolved.length > 0) return resolved;
		throw new WebError(`Baidu search has no API key for "${options.apiKeyEnv ?? DEFAULT_API_KEY_ENV}"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the web-search-baidu config`, 'WEB_PROVIDER_CREDENTIAL_MISSING');
	}
}

/**
 * Race a same-process asynchronous preflight against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort so a later rejection cannot become unhandled.
 */
function abortable(operation, signal) {
	if (signal === undefined) return operation;
	if (signal.aborted) return Promise.reject(searchAborted(signal));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(searchAborted(signal));
		};
		signal.addEventListener('abort', onAbort, { once: true });
		operation.then((value) => {
			signal.removeEventListener('abort', onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener('abort', onAbort);
			reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }));
		});
	});
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal) {
	if (signal?.aborted === true) throw searchAborted(signal);
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal, fallback) {
	return new WebError('Baidu search aborted', 'WEB_ABORTED', { cause: signal?.aborted === true ? signal.reason : fallback });
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === 'AbortError';
}

/** Plugin config — every value is optional; `apply` fills defaults. */
export const Config = z.object({
	/** Literal Baidu Qianfan API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
	apiKey: z.string().role('secret'),
	/** Credential reference resolved for each search; defaults to `BAIDU_QIANFAN_API_KEY`. */
	apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
	/** AI search endpoint. Defaults to `https://qianfan.baidubce.com/v2/ai_search/web_search`. */
	baseURL: z.string().default(BAIDU_DEFAULT_BASE_URL),
	/** `search_source` payload value. Defaults to `baidu_search_v2`. */
	searchSource: z.string().default(DEFAULT_SEARCH_SOURCE),
	/** `resource_type_filter` payload entries, e.g. `[{ type: 'web', top_k: 20 }]`. */
	resourceTypes: z.array(z.object({
		type: z.string(),
		top_k: z.number().step(1).min(1)
	})).default(DEFAULT_RESOURCE_TYPES),
	/** `search_recency_filter` payload value (`year`/`month`/`week`/`day`/`none`). */
	searchRecencyFilter: z.string().default(DEFAULT_SEARCH_RECENCY_FILTER)
});

/** Settings namespace carrying this provider's endpoint and key reference. */
export const WEB_SEARCH_BAIDU_SETTINGS_NAMESPACE = settingsNamespace('web-search-baidu');

/**
 * Project one resolved config section into the options the provider serves its
 * next search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx, config) {
	const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
	const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined;
	return {
		...(literalApiKey === undefined ? {} : { apiKey: literalApiKey }),
		resolveApiKey: async () => {
			const credentials = ctx.get('credentials');
			if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value;
			const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
			return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined;
		},
		apiKeyEnv,
		baseURL: config.baseURL ?? BAIDU_DEFAULT_BASE_URL,
		searchSource: config.searchSource ?? DEFAULT_SEARCH_SOURCE,
		resourceTypes: config.resourceTypes !== undefined && config.resourceTypes.length > 0 ? config.resourceTypes : DEFAULT_RESOURCE_TYPES,
		searchRecencyFilter: config.searchRecencyFilter ?? DEFAULT_SEARCH_RECENCY_FILTER,
		recordRequest: (request) => {
			// `ignorable: true` is REQUIRED for out-of-repo plugin event types:
			// they cannot join the generated KNOWN_SESSION_EVENT_TYPES catalog,
			// and the session reader refuses a log containing an unknown,
			// non-ignorable event (SessionFormatUnsupportedError). The marker
			// tells the reader it may safely skip the record on replay.
			ctx.get('agents')?.currentInitiator()?.session.append('web/baidu-search-request', request, { ignorable: true });
		}
	};
}

/** Register the Baidu search provider with `ctx.web`. */
export function apply(ctx, config) {
	let current = () => config;
	installSettingsSection(ctx, WEB_SEARCH_BAIDU_SETTINGS_NAMESPACE, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: () => {}
	});
	ctx.web.registerSearchProvider(new BaiduSearchProvider(() => resolveOptions(ctx, current())));
}
