import { caseStudies } from "./caseStudies.js";
import {
  buildSystemPrompt,
  CONTACT_FORM_TOKEN_RE,
  CASE_STUDIES_TOKEN_RE,
  CONTACT_EMAIL,
  CONTACT_PHONE,
} from "./systemPrompt.js";
import Anthropic from "@anthropic-ai/sdk";
import { logChat } from "./lib/mongodb.js";

const client = new Anthropic();

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const history = Array.isArray(body?.messages) ? body.messages : null;
    const need = body?.need;
    const conversationId =
      typeof body?.conversationId === "string" ? body.conversationId : null;

    const messages =
      history ?? (need ? [{ role: "user", content: need }] : null);

    if (!messages || messages.length === 0) {
      return res
        .status(400)
        .json({ error: "Missing need or messages parameter" });
    }

    const systemPrompt = buildSystemPrompt(caseStudies);

    const message = await client.messages.create({
      // model: 'claude-sonnet-4-20250514', this model hits token limites with the case studies, so we use a smaller one
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system: systemPrompt,
      messages,
    });

    const rawReply = message.content[0].text;

    const tokenMatch = rawReply.match(CONTACT_FORM_TOKEN_RE);

    // Model sometimes gives out contact info in prose without the token.
    // Fall back to detecting the email/phone directly so the flag doesn't
    // depend entirely on the model remembering to emit it.
    const showContactForm =
      Boolean(tokenMatch) ||
      rawReply.includes(CONTACT_EMAIL) ||
      rawReply.includes(CONTACT_PHONE);
    const needsSummary = tokenMatch?.[1]?.trim() || null;

    const caseStudiesMatch = rawReply.match(CASE_STUDIES_TOKEN_RE);
    let recommendations = [];
    if (caseStudiesMatch) {
      try {
        recommendations = JSON.parse(caseStudiesMatch[1].trim());
      } catch (err) {
        console.error("Failed to parse case studies token:", err);
      }
    }

    // Look up full case study data locally by url — the model only sends
    // url + reason, so a truncated/malformed reply can't leak partial data
    // or let the model fabricate case study details.
    let recommendedCaseStudies = recommendations
      .map((r) => {
        const cs = caseStudies.find((c) => c.url === r.url);
        return cs ? { ...cs, reason: r.reason } : null;
      })
      .filter(Boolean);

    // Model sometimes writes case study urls into the prose instead of the token.
    // Fall back to matching known case study URLs mentioned in the reply.
    if (recommendedCaseStudies.length === 0) {
      recommendedCaseStudies = caseStudies.filter((cs) => rawReply.includes(cs.url));
    }

    const hasCaseStudies = recommendedCaseStudies.length > 0;

    // eg-website-ui's proxy forwards the real visitor's IP via this custom
    // header, since Vercel overwrites x-forwarded-for on each function-to-
    // function hop with the actual connecting IP. Fall back to
    // x-forwarded-for for direct callers (e.g. curl testing this endpoint).
    const ip =
      req.headers["x-original-client-ip"] ||
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      null;

    const reply = rawReply
      .replace(CONTACT_FORM_TOKEN_RE, "")
      .replace(CASE_STUDIES_TOKEN_RE, "")
      // Safety net: if a block got truncated before its closing marker
      // (e.g. hit max_tokens), the regexes above won't match — cut off
      // anything from a dangling opening marker onward so raw token
      // syntax never reaches the user.
      .split(/\[\[(?:CASE_STUDIES|SHOW_CONTACT_FORM)\]\]/)[0]
      .trim();

    await logChat({
      conversationId,
      timestamp: new Date(),
      ip,
      userAgent: req.headers["user-agent"] || null,
      messages: [...messages, { role: "assistant", content: reply }],
      showContactForm,
      needsSummary,
      hasCaseStudies,
    });

    return res.status(200).json({
      reply,
      showContactForm,
      needsSummary,
      hasCaseStudies,
      caseStudies: recommendedCaseStudies,
      messages: [...messages, { role: "assistant", content: reply }],
    });
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ error: err.message });
  }
}
