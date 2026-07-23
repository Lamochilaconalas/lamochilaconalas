// Cloudflare Worker — Proxy seguro para el Planificador de La Mochila con Alas
//
// Rutas (todas POST, mismo Worker):
//   /api/planificador            → genera itinerario (y visado/clima si el país no está cubierto)
//   /api/planificador/email      → guarda un email capturado tras el bloqueo de 3 usos
//   /api/planificador/feedback   → guarda un 👍/👎 sobre la calidad del itinerario
//
// CONFIGURACIÓN NECESARIA:
// - Secret:      ANTHROPIC_API_KEY
// - KV binding:  PLANIFICADOR_KV
// - Routes:      lamochilaconalas.com/api/planificador
//                lamochilaconalas.com/api/planificador/email
//                lamochilaconalas.com/api/planificador/feedback

const MODEL = "claude-haiku-4-5-20251001"; // modelo barato: $1/$5 por millón de tokens
const RATE_LIMIT_MAX_PER_IP = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const DAILY_GLOBAL_MAX = 150;

const rateLimitMap = new Map();

function isIpRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX_PER_IP;
}

function todayKey() {
  return `daily:${new Date().toISOString().slice(0, 10)}`;
}

async function isDailyLimitReached(kv) {
  const key = todayKey();
  const current = parseInt((await kv.get(key)) || "0", 10);
  return { reached: current >= DAILY_GLOBAL_MAX, current, key };
}

async function incrementDailyCount(kv, key, current) {
  await kv.put(key, String(current + 1), { expirationTtl: 60 * 60 * 24 * 2 });
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// System prompt: SOLO se usa para países que aún no están cubiertos por
// visados.json / clima.json / lugares.json. Los países cubiertos (México, Tailandia,
// Jordania, Turquía) ya no llaman a este Worker nunca — su itinerario se ensambla
// en el navegador a partir de datos reales, sin IA y sin coste.
const SYSTEM_PROMPT_COMPLETO = `Eres el planificador experto de La Mochila con Alas, guía de viajes para mochileros hispanohablantes.

Responde ÚNICAMENTE con JSON válido. Sin backticks, sin texto extra. Estructura exacta:

{
  "titulo": "string",
  "resumen": "string (máx 2 frases evocadoras y concretas)",
  "modo": "libre" o "radio",
  "origen_referencia": "ciudad de partida si hay radio, si no null",
  "visado": {
    "tipo": "libre" | "visa_on_arrival" | "evisa" | "visa_requerida" | "no_permitido",
    "etiqueta": "Sin visado" | "Visa a la llegada" | "eVisa" | "Visa requerida" | "No permitido",
    "duracion": "string",
    "coste": "string",
    "info": "string (1-2 frases con detalles clave para esa nacionalidad)"
  },
  "clima": {
    "mes": "string",
    "temperatura": "string",
    "descripcion": "string (2 frases)",
    "temporada": "ideal" | "buena" | "aceptable" | "evitar",
    "etiqueta_temporada": "string",
    "festividades": "string o null"
  },
  "dias": [
    {
      "dia": 1, "ciudad": "string", "distancia_km": null,
      "emoji": "string", "titulo": "string",
      "manana": ["string"], "tarde": ["string"], "noche": ["string"],
      "consejo": "string", "transporte": "string"
    }
  ],
  "lugares_cercanos": null,
  "consejos_esenciales": ["string", "string", "string"]
}

REGLAS: visado e info del clima deben ser precisos para la nacionalidad/mes indicados. Exactamente el número de días solicitado. Adapta todo al presupuesto.`;

async function callAnthropic(env, system, userPrompt, maxTokens) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  return { status: response.status, data: await response.json() };
}

async function handlePlanificador(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  if (isIpRateLimited(ip)) {
    return jsonResponse(
      { error: "Has hecho demasiadas peticiones. Espera un poco antes de volver a intentarlo." },
      429
    );
  }

  const { reached, current, key } = await isDailyLimitReached(env.PLANIFICADOR_KV);
  if (reached) {
    return jsonResponse(
      { error: "Hemos alcanzado el límite de planificaciones de hoy. Vuelve mañana." },
      429
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "JSON inválido" }, 400);
  }

  if (!body.prompt || typeof body.prompt !== "string") {
    return jsonResponse({ error: "Falta el prompt" }, 400);
  }

  try {
    const { status, data } = await callAnthropic(env, SYSTEM_PROMPT_COMPLETO, body.prompt, 5000);
    if (status === 200) {
      await incrementDailyCount(env.PLANIFICADOR_KV, key, current);
    }
    return jsonResponse(data, status);
  } catch (err) {
    return jsonResponse({ error: "Error al contactar con la API" }, 502);
  }
}

async function handleEmailCapture(request, env) {
  // Captura de email para la newsletter del blog (guías y posts nuevos) —
  // se activa cuando alguien quiere seguir usando el planificador tras 3 usos gratis.
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "JSON inválido" }, 400);
  }

  const email = (body.email || "").trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return jsonResponse({ error: "Email no válido" }, 400);
  }

  const interes = typeof body.interes === "string" ? body.interes.trim().slice(0, 100) : null;

  // Guardamos en KV: email:<direccion> -> { fecha, interés (último destino buscado) }
  // El interés sirve para segmentar futuros envíos (ej. alguien buscó "Petra" →
  // avisarle cuando publiques contenido nuevo sobre Jordania).
  const key = `email:${email}`;
  const already = await env.PLANIFICADOR_KV.get(key);
  if (!already) {
    await env.PLANIFICADOR_KV.put(key, JSON.stringify({ fecha: new Date().toISOString(), interes }));
  }

  return jsonResponse({ ok: true }, 200);
}

async function handleFeedback(request, env) {
  // Guarda un contador simple de 👍/👎 por día, más una lista corta de comentarios
  // implícitos (qué destino se valoró) para poder revisar qué itinerarios fallan.
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "JSON inválido" }, 400);
  }

  const util = body.util === true;
  const destino = typeof body.destino === "string" ? body.destino.trim().slice(0, 100) : "desconocido";
  const dateKey = new Date().toISOString().slice(0, 10);
  const counterKey = `feedback_count:${dateKey}:${util ? "util" : "no_util"}`;
  const current = parseInt((await env.PLANIFICADOR_KV.get(counterKey)) || "0", 10);
  await env.PLANIFICADOR_KV.put(counterKey, String(current + 1), { expirationTtl: 60 * 60 * 24 * 90 });

  // Solo guardamos el detalle de los negativos (los que hay que revisar)
  if (!util) {
    const detailKey = `feedback_negativo:${dateKey}:${Date.now()}`;
    await env.PLANIFICADOR_KV.put(detailKey, destino, { expirationTtl: 60 * 60 * 24 * 90 });
  }

  return jsonResponse({ ok: true }, 200);
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Método no permitido" }, 405);
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/planificador/email") {
      return handleEmailCapture(request, env);
    }
    if (url.pathname === "/api/planificador/feedback") {
      return handleFeedback(request, env);
    }
    if (url.pathname === "/api/planificador") {
      return handlePlanificador(request, env);
    }
    return jsonResponse({ error: "Ruta no encontrada" }, 404);
  },
};
