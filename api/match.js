import { caseStudies } from './caseStudies.js';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const need = body?.need;

    if (!need) {
      return res.status(400).json({ error: 'Missing need parameter' });
    }

    const systemPrompt = `
You are a helpful assistant for a marketing agency.
Your job is to read a potential client's marketing need and recommend the 2-3 most relevant case studies from the list below.
Return ONLY a JSON array. No explanation, no markdown. Example format:
[{ "title": "...", "url": "...", "reason": "One sentence why this is relevant" }]

CASE STUDIES:
${JSON.stringify(caseStudies, null, 2)}
    `;

    const message = await client.messages.create({
      // model: 'claude-sonnet-4-20250514', this model hits token limites with the case studies, so we use a smaller one
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: need }]
    });

    const raw = message.content[0].text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const matches = JSON.parse(raw);
    return res.status(200).json({ matches });

  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
}