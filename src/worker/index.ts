/**
 * Agent Visibility Worker
 *
 * Serves one enriched content store through every agent-discovery surface:
 *
 *   GET /llms.txt                          — llms.txt index (Markdown)
 *   GET /llms-full.txt                     — full content inlined (Markdown)
 *   GET /index.json                        — typed JSON index
 *   GET /:slug.md                          — per-page Markdown (groundable)
 *   GET /:slug.jsonld                      — per-page schema.org JSON-LD
 *   GET /jsonld                            — site-level schema.org JSON-LD
 *   GET /robots.txt                        — explicit AI-bot directives
 *
 * Plus a small JSON API the bundled UI uses, and an OPTIONAL Web Bot Auth
 * identity surface (disabled unless ENABLE_WEB_BOT_AUTH=true).
 *
 * Every text surface sends a `Content-Signal` header declaring how agents may
 * use the content (see https://contentsignals.org / the Content-Signals
 * proposal). The React SPA at `/` is served from static assets.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
	renderIndexJson,
	renderLlmsFullTxt,
	renderLlmsTxt,
	renderResourceJsonLd,
	renderResourceMd,
	renderRobotsTxt,
	renderWebsiteJsonLd,
} from "../enrichment/surfaces";
import {
	clearCache,
	getResources,
	siteConfig,
	upsertResource,
} from "../lib/store";
import type { Env, RawResource } from "../lib/types";
import {
	directoryDocument,
	SAMPLE_AGENT_KEYS,
	verifyAgentIdentity,
} from "../lib/web-bot-auth";

const DEFAULT_CHAT_MODEL = "@cf/google/gemma-4-26b-a4b-it";

const CHAT_INSTRUCTIONS = `
Você é o assistente comercial em fase de testes do Ateliê Art.Ron Cerâmicas, em Curitiba.

Seu objetivo é acolher, entender o interesse da pessoa e ajudar a equipe a conduzir o atendimento comercial.

Regras obrigatórias:
- Responda sempre em português do Brasil, com linguagem humana, calorosa, clara e profissional.
- Seja breve. Normalmente use de 2 a 5 frases e faça somente uma pergunta por vez.
- Não invente preços, datas, vagas, políticas, descontos, prazos ou características de uma oficina.
- Nesta fase de testes, se a informação não estiver nesta conversa, diga que precisa confirmar com a equipe.
- Nunca afirme que uma reserva, pagamento, cancelamento ou alteração foi concluída.
- Não solicite senha, documento, dados bancários ou informações sensíveis.
- Se houver reclamação, pedido de reembolso, acidente, questão jurídica, solicitação fora das regras ou pedido para falar com uma pessoa, encaminhe para a equipe.
- Não diga que é humano. Se perguntarem, explique que é o assistente virtual em testes do Ateliê Art.Ron.
- Não pressione a pessoa e não crie urgência falsa.
- Quando fizer sentido, identifique: experiência desejada, quantidade de participantes e preferência de data ou período.
`;

const CHAT_PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Assistente Art.Ron — Ambiente de teste</title>
  <style>
    :root { color-scheme: light; --argila:#a64f2d; --creme:#fbf6ee; --escuro:#2d241f; --linha:#e8d9ca; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:Arial,Helvetica,sans-serif; background:var(--creme); color:var(--escuro); }
    main { width:min(760px,92vw); margin:36px auto; }
    h1 { margin:0 0 8px; font-size:clamp(25px,4vw,38px); }
    .aviso { margin:0 0 20px; color:#6d5c51; line-height:1.5; }
    .painel { background:#fff; border:1px solid var(--linha); border-radius:18px; box-shadow:0 12px 35px rgba(73,46,29,.08); overflow:hidden; }
    .topo { padding:18px; border-bottom:1px solid var(--linha); display:grid; gap:8px; }
    label { font-size:14px; font-weight:700; }
    input, textarea, button { font:inherit; }
    input, textarea { width:100%; border:1px solid #cdb9a8; border-radius:10px; padding:12px; background:#fff; }
    input:focus, textarea:focus { outline:3px solid rgba(166,79,45,.16); border-color:var(--argila); }
    #conversa { min-height:300px; max-height:52vh; overflow:auto; padding:18px; display:flex; flex-direction:column; gap:12px; }
    .msg { max-width:84%; padding:11px 14px; border-radius:14px; line-height:1.45; white-space:pre-wrap; }
    .usuario { align-self:flex-end; background:var(--argila); color:#fff; border-bottom-right-radius:4px; }
    .assistente { align-self:flex-start; background:#f2e8de; border-bottom-left-radius:4px; }
    form { border-top:1px solid var(--linha); padding:16px; display:grid; gap:10px; }
    textarea { min-height:82px; resize:vertical; }
    button { border:0; border-radius:10px; padding:12px 16px; background:var(--argila); color:#fff; font-weight:700; cursor:pointer; }
    button:disabled { opacity:.55; cursor:wait; }
    .status { min-height:20px; color:#8a3325; font-size:14px; }
    small { color:#75665d; }
  </style>
</head>
<body>
  <main>
    <h1>Assistente Art.Ron</h1>
    <p class="aviso">Ambiente interno de testes. Não informe dados reais ou sensíveis de clientes.</p>
    <section class="painel">
      <div class="topo">
        <label for="codigo">Senha de teste</label>
        <input id="codigo" type="password" autocomplete="off" placeholder="Digite a senha configurada na Cloudflare">
        <small>A senha não fica gravada neste site.</small>
      </div>
      <div id="conversa" aria-live="polite">
        <div class="msg assistente">Olá! Sou o assistente virtual em testes do Ateliê Art.Ron. Como posso ajudar?</div>
      </div>
      <form id="formulario">
        <label for="mensagem">Mensagem de teste</label>
        <textarea id="mensagem" maxlength="1500" placeholder="Exemplo: Quero conhecer uma oficina de cerâmica no sábado."></textarea>
        <button id="enviar" type="submit">Enviar mensagem</button>
        <div id="status" class="status" role="status"></div>
      </form>
    </section>
  </main>
  <script>
    const formulario = document.getElementById('formulario');
    const mensagem = document.getElementById('mensagem');
    const codigo = document.getElementById('codigo');
    const conversa = document.getElementById('conversa');
    const status = document.getElementById('status');
    const enviar = document.getElementById('enviar');
    const historico = [];

    function adicionar(texto, classe) {
      const item = document.createElement('div');
      item.className = 'msg ' + classe;
      item.textContent = texto;
      conversa.appendChild(item);
      conversa.scrollTop = conversa.scrollHeight;
    }

    formulario.addEventListener('submit', async function (evento) {
      evento.preventDefault();
      const texto = mensagem.value.trim();
      const senha = codigo.value;
      status.textContent = '';
      if (!senha) { status.textContent = 'Digite a senha de teste.'; return; }
      if (!texto) { status.textContent = 'Digite uma mensagem.'; return; }

      adicionar(texto, 'usuario');
      mensagem.value = '';
      enviar.disabled = true;
      status.textContent = 'Gerando resposta...';

      try {
        const resposta = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-access-code': senha },
          body: JSON.stringify({ message: texto, history: historico })
        });
        const dados = await resposta.json();
        if (!resposta.ok) throw new Error(dados.error || 'Não foi possível responder.');
        adicionar(dados.reply, 'assistente');
        historico.push({ role: 'user', content: texto });
        historico.push({ role: 'assistant', content: dados.reply });
        if (historico.length > 8) historico.splice(0, historico.length - 8);
        status.textContent = '';
      } catch (erro) {
        status.textContent = erro instanceof Error ? erro.message : 'Ocorreu um erro no teste.';
      } finally {
        enviar.disabled = false;
        mensagem.focus();
      }
    });
  </script>
</body>
</html>`;

interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

interface ChatRequestBody {
	message?: unknown;
	history?: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=UTF-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	});
}

function extractAiText(result: unknown): string {
	if (typeof result === "string") return result.trim();
	if (!result || typeof result !== "object") return "";

	const record = result as Record<string, unknown>;
	if (typeof record.response === "string") return record.response.trim();

	if (record.result && typeof record.result === "object") {
		const nested = record.result as Record<string, unknown>;
		if (typeof nested.response === "string") return nested.response.trim();
	}

	if (!Array.isArray(record.choices) || record.choices.length === 0) return "";
	const first = record.choices[0];
	if (!first || typeof first !== "object") return "";
	const message = (first as Record<string, unknown>).message;
	if (!message || typeof message !== "object") return "";
	const content = (message as Record<string, unknown>).content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const value = part as Record<string, unknown>;
			if (typeof value.text === "string") return value.text;
			if (typeof value.content === "string") return value.content;
			return "";
		})
		.join("\n")
		.trim();
}

function sanitizedHistory(value: unknown): ChatMessage[] {
	if (!Array.isArray(value)) return [];

	return value.slice(-8).flatMap((item): ChatMessage[] => {
		if (!item || typeof item !== "object") return [];
		const record = item as Record<string, unknown>;
		const role = record.role;
		const content =
			typeof record.content === "string" ? record.content.slice(0, 1500).trim() : "";
		if ((role !== "user" && role !== "assistant") || !content) return [];
		return [{ role, content }];
	});
}

async function handleChat(request: Request, env: Env): Promise<Response> {
	if (!env.AI) {
		return jsonResponse({ error: "O vínculo Workers AI não está configurado." }, 503);
	}
	if (!env.TEST_ACCESS_CODE) {
		return jsonResponse({ error: "A senha de teste ainda não foi configurada." }, 503);
	}

	const receivedCode = request.headers.get("x-access-code") ?? "";
	if (receivedCode !== env.TEST_ACCESS_CODE) {
		return jsonResponse({ error: "Senha de teste incorreta." }, 401);
	}

	let body: ChatRequestBody;
	try {
		body = (await request.json()) as ChatRequestBody;
	} catch {
		return jsonResponse({ error: "Mensagem inválida." }, 400);
	}

	const userMessage = typeof body.message === "string" ? body.message.trim() : "";
	if (!userMessage) return jsonResponse({ error: "Digite uma mensagem." }, 400);
	if (userMessage.length > 1500) {
		return jsonResponse({ error: "A mensagem ultrapassou 1.500 caracteres." }, 400);
	}

	const messages = [
		{ role: "system", content: CHAT_INSTRUCTIONS },
		...sanitizedHistory(body.history),
		{ role: "user", content: userMessage },
	];

	try {
		const model = env.AI_MODEL || DEFAULT_CHAT_MODEL;
		const result = (await env.AI.run(model as keyof AiModels, {
			messages,
			max_tokens: 350,
			temperature: 0.3,
		})) as unknown;

		const reply = extractAiText(result);
		if (!reply) {
			return jsonResponse({ error: "O modelo não devolveu uma resposta válida." }, 502);
		}
		return jsonResponse({ reply });
	} catch (error) {
		console.error("Falha no Workers AI", error);
		return jsonResponse(
			{ error: "A inteligência artificial não respondeu. Tente novamente em instantes." },
			502,
		);
	}
}

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
	console.error(`[Error] ${c.req.method} ${c.req.path}: ${err.message}`);
	// Match the response type to the surface: text surfaces shouldn't get a
	// JSON error body.
	if (/\.(md|txt)$/.test(c.req.path)) {
		return c.text("Internal server error", 500);
	}
	return c.json({ error: "Internal server error" }, 500);
});

function originOf(url: string): string {
	return new URL(url).origin;
}

// --- Validation limits for user-supplied content ---------------------------
const MAX_BODY_BYTES = 100_000; // raw content we'll persist per resource
const MAX_RESOURCES = 100; // cap total resources to bound KV growth
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

/** Constant-time-ish bearer check for the mutating routes. */
function isAuthorized(c: {
	env: Env;
	req: { header: (k: string) => string | undefined };
}): boolean {
	const configured = c.env.ADMIN_TOKEN;
	if (!configured) return false;
	const header = c.req.header("authorization") ?? "";
	const token = header.replace(/^Bearer\s+/i, "");
	return token.length > 0 && token === configured;
}

/** Apply the Content-Signal header declaring agent usage intent. */
function contentSignal(c: { env: Env }): Record<string, string> {
	return {
		"Content-Signal":
			c.env.CONTENT_SIGNAL || "ai-input=yes, search=yes, ai-train=no",
	};
}

// Internal pilot page. It stays protected by TEST_ACCESS_CODE and is not yet
// connected to real Kommo conversations.
app.get("/", (c) =>
	c.html(CHAT_PAGE, 200, {
		"Cache-Control": "no-store",
		"Content-Security-Policy":
			"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
		"X-Content-Type-Options": "nosniff",
	}),
);

app.get("/health", (c) =>
	c.json({ ok: true, service: "artron-kommo-ai", aiConfigured: Boolean(c.env.AI) }),
);

app.post("/api/chat", (c) => handleChat(c.req.raw, c.env));

// CORS so agents can fetch the machine-readable surfaces from anywhere.
app.use("/llms.txt", cors());
app.use("/llms-full.txt", cors());
app.use("/index.json", cors());
app.use("/jsonld", cors());
// NB: Hono's "*" wildcard does not match a literal ".md"/".jsonld" suffix, so
// the per-page surfaces need the same regex matcher their routes use.
app.use("/:file{.+\\.md}", cors());
app.use("/:file{.+\\.jsonld}", cors());

// ---------------------------------------------------------------------------
// Machine-readable surfaces
// ---------------------------------------------------------------------------

app.get("/llms.txt", async (c) => {
	const site = siteConfig(c.env, originOf(c.req.url));
	const resources = await getResources(c.env);
	return c.text(renderLlmsTxt({ site, resources }), 200, {
		"Content-Type": "text/plain; charset=utf-8",
		...contentSignal(c),
	});
});

app.get("/llms-full.txt", async (c) => {
	const site = siteConfig(c.env, originOf(c.req.url));
	const resources = await getResources(c.env);
	return c.text(renderLlmsFullTxt({ site, resources }), 200, {
		"Content-Type": "text/plain; charset=utf-8",
		...contentSignal(c),
	});
});

app.get("/index.json", async (c) => {
	const site = siteConfig(c.env, originOf(c.req.url));
	const resources = await getResources(c.env);
	c.header("Content-Signal", contentSignal(c)["Content-Signal"]);
	return c.json(renderIndexJson({ site, resources }));
});

app.get("/robots.txt", async (c) => {
	const site = siteConfig(c.env, originOf(c.req.url));
	const resources = await getResources(c.env);
	return c.text(
		renderRobotsTxt({
			site,
			resources,
			contentSignal: contentSignal(c)["Content-Signal"],
		}),
		200,
		{
			"Content-Type": "text/plain; charset=utf-8",
			...contentSignal(c),
		},
	);
});

app.get("/jsonld", async (c) => {
	const site = siteConfig(c.env, originOf(c.req.url));
	const resources = await getResources(c.env);
	return c.json(renderWebsiteJsonLd({ site, resources }), 200, {
		"Content-Type": "application/ld+json; charset=utf-8",
		...contentSignal(c),
	});
});

// Per-page Markdown: /:slug.md
app.get("/:file{.+\\.md}", async (c) => {
	const slug = c.req.param("file").replace(/\.md$/, "");
	const site = siteConfig(c.env, originOf(c.req.url));
	const resources = await getResources(c.env);
	const resource = resources.find((r) => r.slug === slug);
	if (!resource) return c.notFound();
	return c.text(renderResourceMd({ resource, site }), 200, {
		"Content-Type": "text/markdown; charset=utf-8",
		...contentSignal(c),
	});
});

// Per-page JSON-LD: /:slug.jsonld
app.get("/:file{.+\\.jsonld}", async (c) => {
	const slug = c.req.param("file").replace(/\.jsonld$/, "");
	const site = siteConfig(c.env, originOf(c.req.url));
	const resources = await getResources(c.env);
	const resource = resources.find((r) => r.slug === slug);
	if (!resource) return c.notFound();
	return c.json(renderResourceJsonLd({ resource, site }), 200, {
		"Content-Type": "application/ld+json; charset=utf-8",
		...contentSignal(c),
	});
});

// ---------------------------------------------------------------------------
// JSON API for the bundled UI
// ---------------------------------------------------------------------------

app.get("/api/site", async (c) => {
	const site = siteConfig(c.env, originOf(c.req.url));
	return c.json({
		site,
		webBotAuthEnabled: c.env.ENABLE_WEB_BOT_AUTH === "true",
		surfaces: [
			{ id: "llms-txt", label: "llms.txt", path: "/llms.txt", kind: "text" },
			{
				id: "llms-full",
				label: "llms-full.txt",
				path: "/llms-full.txt",
				kind: "text",
			},
			{
				id: "index-json",
				label: "index.json",
				path: "/index.json",
				kind: "json",
			},
			{ id: "robots", label: "robots.txt", path: "/robots.txt", kind: "text" },
			{ id: "jsonld", label: "JSON-LD", path: "/jsonld", kind: "json" },
		],
	});
});

app.get("/api/resources", async (c) => {
	const resources = await getResources(c.env);
	return c.json({ count: resources.length, resources });
});

app.get("/api/resources/:slug", async (c) => {
	const resources = await getResources(c.env);
	const resource = resources.find((r) => r.slug === c.req.param("slug"));
	if (!resource) return c.json({ error: "Not found" }, 404);
	return c.json(resource);
});

app.post("/api/resources", async (c) => {
	if (!isAuthorized(c)) {
		return c.json({ error: "Unauthorized. Set the ADMIN_TOKEN secret." }, 401);
	}
	const body = await c.req.json<Partial<RawResource>>().catch(() => null);
	if (!body?.slug || !body?.body) {
		return c.json({ error: "Missing required fields: slug, body" }, 400);
	}

	const slug = String(body.slug);
	if (!SLUG_RE.test(slug)) {
		return c.json({ error: "Invalid slug: use 1–63 chars of [a-z0-9-]." }, 400);
	}

	const rawBody = String(body.body);
	if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
		return c.json(
			{ error: `Body too large (max ${MAX_BODY_BYTES} bytes).` },
			400,
		);
	}

	let url = `${originOf(c.req.url)}/${slug}`;
	if (body.url) {
		try {
			const parsed = new URL(String(body.url));
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				return c.json({ error: "url must be http(s)." }, 400);
			}
			url = parsed.toString();
		} catch {
			return c.json({ error: "url is not a valid URL." }, 400);
		}
	}

	const raw: RawResource = {
		slug,
		url,
		title: body.title ? String(body.title).slice(0, 200) : undefined,
		body: rawBody,
	};

	try {
		const enriched = await upsertResource(c.env, raw, MAX_RESOURCES);
		return c.json(enriched, 201);
	} catch (err) {
		if ((err as Error).message === "RESOURCE_LIMIT") {
			return c.json(
				{ error: `Resource limit reached (max ${MAX_RESOURCES}).` },
				409,
			);
		}
		throw err;
	}
});

app.post("/api/refresh", async (c) => {
	if (!isAuthorized(c)) {
		return c.json({ error: "Unauthorized. Set the ADMIN_TOKEN secret." }, 401);
	}
	await clearCache(c.env);
	return c.json({
		ok: true,
		message: "Cache cleared; surfaces will re-enrich.",
	});
});

// ---------------------------------------------------------------------------
// OPTIONAL — Web Bot Auth identity surface (off by default)
// ---------------------------------------------------------------------------

app.get("/.well-known/web-bot-auth/directory", (c) => {
	if (c.env.ENABLE_WEB_BOT_AUTH !== "true") return c.notFound();
	return c.json(directoryDocument(SAMPLE_AGENT_KEYS));
});

app.all("/api/identity", async (c) => {
	if (c.env.ENABLE_WEB_BOT_AUTH !== "true") {
		return c.json({ error: "Web Bot Auth is disabled" }, 404);
	}
	const result = await verifyAgentIdentity(c.req.raw, SAMPLE_AGENT_KEYS);
	return c.json(result);
});

export default app;
