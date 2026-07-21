import { caseStudies } from "./caseStudies.js";
import Anthropic from "@anthropic-ai/sdk";

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

    const messages =
      history ?? (need ? [{ role: "user", content: need }] : null);

    if (!messages || messages.length === 0) {
      return res
        .status(400)
        .json({ error: "Missing need or messages parameter" });
    }

    const CONTACT_FORM_TOKEN_RE = /\[\[SHOW_CONTACT_FORM\]\]([\s\S]*?)\[\[\/SHOW_CONTACT_FORM\]\]/;
    const CASE_STUDIES_TOKEN_RE = /\[\[CASE_STUDIES\]\]([\s\S]*?)\[\[\/CASE_STUDIES\]\]/;

    const systemPrompt = `
    You are a helpful assistant for a marketing agency.
    Your job is to read a potential client's marketing needs and gather more information.
    Use the following case studies as reference to understand the types of services and industries Estipona Group has experience with.
    Do not recommend any other marketing agencies or services outside of Estipona Group. Instead, ask questions to clarify the client's needs and goals.
    Be very concise and professional in your responses. Ask only 1 or 2 questions each time. If the client has already provided enough information, you may summarize their needs and suggest next steps.
    If use prompts for cost estimate, prompt to schedule a call with Estipona Group to discuss their needs in more detail.

    Always refer to the case studies when providing recommendations. If one or more case studies are relevant to the client's needs, end your reply with a block of the exact form [[CASE_STUDIES]]<json array>[[/CASE_STUDIES]] on its own line, where <json array> is a JSON array (no markdown) containing ONLY the url and a one-sentence reason for each relevant case study, in this format:
[[CASE_STUDIES]][{ "url": "...", "reason": "One sentence why this is relevant" }][[/CASE_STUDIES]]
    Do not repeat the case study title, summary, or other fields in the block or in your reply — the url is enough to look it up. Do not include any case studies that are not relevant to the client's needs.
    If relevant case studies then reply "Here's the relevant case studies based on your needs:" before the block, and if no relevant case studies then reply "Based on your needs, we don't have any relevant case studies to share at this time." and do not include the block at all.
    Never mention this block to the user.

    When recommending contacting Estipona Group, provide the following contact information:
    Estipona Group contact information:
    Email: info@estiponagroup.com
    Phone: 775.786.4445
    Whenever you give the user contact info, or the user is ready to get in touch, end your reply with a block of the exact form [[SHOW_CONTACT_FORM]]<summary>[[/SHOW_CONTACT_FORM]] on its own line, where <summary> is a concise (1-2 sentence) third-person summary of the client's needs so far, suitable for pre-filling a contact form. Never use this block for any other reason, and never mention it to the user.

CASE STUDIES:
${JSON.stringify(caseStudies, null, 2)}
    `;

    const message = await client.messages.create({
      // model: 'claude-sonnet-4-20250514', this model hits token limites with the case studies, so we use a smaller one
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system: systemPrompt,
      messages,
    });

    const rawReply = message.content[0].text;

    const tokenMatch = rawReply.match(CONTACT_FORM_TOKEN_RE);
    const showContactForm = Boolean(tokenMatch);
    const needsSummary = tokenMatch ? tokenMatch[1].trim() : null;

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

    const reply = rawReply
      .replace(CONTACT_FORM_TOKEN_RE, "")
      .replace(CASE_STUDIES_TOKEN_RE, "")
      // Safety net: if a block got truncated before its closing marker
      // (e.g. hit max_tokens), the regexes above won't match — cut off
      // anything from a dangling opening marker onward so raw token
      // syntax never reaches the user.
      .split(/\[\[(?:CASE_STUDIES|SHOW_CONTACT_FORM)\]\]/)[0]
      .trim();

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
