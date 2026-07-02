const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();

// CORS configuration - restrict to your domain
const corsOptions = {
  origin: [
    'http://localhost:3000',
    'http://localhost:5000',
    'https://kprpalvai.github.io',
    process.env.ALLOWED_ORIGIN
  ].filter(Boolean),
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Serve static site (the current folder)
app.use(express.static(path.join(__dirname)));

// Load local KB (simple JSON array of {id,title,content})
let KB = [];
let EMB = [];

try {
  const raw = fs.readFileSync(path.join(__dirname, 'copilot-kb.json'), 'utf8');
  KB = JSON.parse(raw);
  console.log('Loaded KB entries:', KB.length);
} catch (e) {
  console.warn('No copilot-kb.json found or invalid JSON; KB empty.');
}

// Try to load precomputed embeddings
try {
  const raw = fs.readFileSync(path.join(__dirname, 'copilot-embeddings.json'), 'utf8');
  EMB = JSON.parse(raw);
  console.log('Loaded embeddings:', EMB.length);
} catch (e) {
  console.warn('No copilot-embeddings.json found; embeddings empty.');
}

// OpenAI client (optional)
const OPENAI_KEY = process.env.OPENAI_API_KEY || null;
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

// Utility functions for embeddings
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i] * b[i];
  }
  return s;
}

function norm(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i] * a[i];
  }
  return Math.sqrt(s);
}

function cosineSim(a, b) {
  return dot(a, b) / (norm(a) * norm(b) + 1e-12);
}

async function embedText(text) {
  if (!openai) return null;
  try {
    const r = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text
    });
    return r.data[0].embedding;
  } catch (e) {
    console.error('Embedding error:', e.message);
    return null;
  }
}

function searchEmbeddings(queryEmbedding, topK = 3) {
  if (!queryEmbedding || !EMB || EMB.length === 0) return [];
  const scored = EMB.map(d => ({
    ...d,
    score: cosineSim(queryEmbedding, d.embedding)
  }));
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    openai_available: !!openai,
    embeddings_count: EMB.length,
    kb_entries: KB.length
  });
});

// Route to rebuild embeddings server-side (requires OPENAI_API_KEY)
app.post('/api/index', async (req, res) => {
  if (!openai) {
    return res.status(400).json({ error: 'OPENAI_API_KEY not set' });
  }

  try {
    const kb = KB;
    const out = [];

    for (const doc of kb) {
      const txt = (doc.title || '') + '\n\n' + (doc.content || '');
      const r = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: txt
      });
      const emb = r.data[0].embedding;
      out.push({
        id: doc.id,
        title: doc.title,
        content: doc.content,
        embedding: emb
      });
    }

    fs.writeFileSync(
      path.join(__dirname, 'copilot-embeddings.json'),
      JSON.stringify(out, null, 2),
      'utf8'
    );

    EMB = out;
    return res.json({ ok: true, indexed: out.length });
  } catch (e) {
    console.error('Indexing error:', e);
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// /api/copilot: accepts {query,context,history} and returns {reply, sources}
app.post('/api/copilot', async (req, res) => {
  const { query, context, history } = req.body || {};

  if (!query) {
    return res.status(400).json({ error: 'missing query' });
  }

  try {
    // If we have embeddings, compute query embedding and retrieve top hits
    if (openai && EMB && EMB.length > 0) {
      const qemb = await embedText(query);
      if (!qemb) {
        return res.status(500).json({ error: 'Failed to embed query' });
      }

      const hits = searchEmbeddings(qemb, 4);
      const contextText = hits
        .map(h => `[${h.id}] ${h.title}\n${h.content}`)
        .join('\n\n---\n\n');

      // If OpenAI key present, synthesize an answer using retrieved context
      if (openai) {
        const system = `You are a helpful assistant that answers user questions using the provided research excerpts. 
If the answer is not contained in the context, say you don't know.`;

        const messages = [
          { role: 'system', content: system },
          {
            role: 'system',
            content: 'Context:\n' + contextText
          },
          { role: 'user', content: query }
        ];

        const chat = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages,
          max_tokens: 400,
          temperature: 0.7
        });

        const reply =
          chat.choices?.[0]?.message?.content ||
          chat.choices?.[0]?.text ||
          'No reply';

        return res.json({
          reply,
          sources: hits.map(h => ({
            id: h.id,
            title: h.title,
            score: h.score
          }))
        });
      }

      // Fallback: return hits
      const reply =
        'Top matches from local embeddings:\n\n' +
        hits.map(h => `- ${h.title}: ${h.content.slice(0, 600)}`).join('\n\n');

      return res.json({
        reply,
        sources: hits.map(h => ({
          id: h.id,
          title: h.title,
          score: h.score
        }))
      });
    }

    // Fallback to simple keyword retrieval if no embeddings or error
    const q = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = KB.map(d => {
      const txt = (d.title + ' ' + d.content).toLowerCase();
      let score = 0;
      for (const w of q) {
        if (txt.includes(w)) score++;
      }
      return { ...d, score };
    })
      .filter(d => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (hits.length) {
      const reply =
        'Top matches from research documents:\n\n' +
        hits.map(h => `- ${h.title}: ${h.content.slice(0, 600)}`).join('\n\n');

      return res.json({
        reply,
        sources: hits.map(h => ({
          id: h.id,
          title: h.title,
          score: h.score
        }))
      });
    }

    return res.json({
      reply:
        "I couldn't find a matching research excerpt locally. You can POST to /api/index with an OPENAI_API_KEY to build embeddings."
    });
  } catch (e) {
    console.error('Copilot error:', e);
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// Streaming endpoint: proxy OpenAI streaming responses to the client
app.post('/api/copilot/stream', async (req, res) => {
  const { query, context, history } = req.body || {};

  if (!query) {
    return res.status(400).json({ error: 'missing query' });
  }

  // Set streaming headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    // If OpenAI available and embeddings present, build prompt and stream
    if (OPENAI_KEY && EMB && EMB.length > 0) {
      const qemb = await embedText(query);
      if (!qemb) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ error: 'Failed to embed query' })}\n\n`
        );
        return res.end();
      }

      const hits = searchEmbeddings(qemb, 4);
      const contextText = hits
        .map(h => `[${h.id}] ${h.title}\n${h.content}`)
        .join('\n\n---\n\n');

      const system = `You are a helpful assistant that answers user questions using the provided research excerpts. 
If the answer is not contained in the context, say you don't know.`;

      const messages = [
        { role: 'system', content: system },
        { role: 'system', content: 'Context:\n' + contextText },
        { role: 'user', content: query }
      ];

      // Call OpenAI Chat Completions streaming API via fetch
      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages,
          max_tokens: 600,
          stream: true,
          temperature: 0.7
        })
      });

      if (!openaiRes.ok) {
        const txt = await openaiRes.text();
        res.write(`event: error\ndata: ${JSON.stringify({ error: txt })}\n\n`);
        return res.end();
      }

      const reader = openaiRes.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let done = false;

      // Stream parsing: OpenAI sends lines like 'data: {json}\n\n'
      while (!done) {
        const { value, done: rdone } = await reader.read();
        if (rdone) break;

        const chunk = decoder.decode(value, { stream: true });
        const parts = chunk.split(/\n\n/).map(p => p.trim()).filter(Boolean);

        for (const part of parts) {
          if (!part.startsWith('data:')) continue;

          const payload = part.replace(/^data:\s*/, '').trim();

          if (payload === '[DONE]') {
            done = true;
            break;
          }

          try {
            const j = JSON.parse(payload);
            const delta =
              j.choices &&
              j.choices[0] &&
              j.choices[0].delta &&
              j.choices[0].delta.content;

            if (delta) {
              res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }

      // After streaming content, send sources event
      try {
        const sources = hits.map(h => ({
          id: h.id,
          title: h.title,
          score: h.score
        }));
        res.write(`event: sources\ndata: ${JSON.stringify(sources)}\n\n`);
      } catch (e) {
        /* ignore */
      }

      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // Fallback streaming: stream matching local KB excerpts as chunks
    const q = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = KB.map(d => {
      const txt = (d.title + ' ' + d.content).toLowerCase();
      let score = 0;
      for (const w of q) {
        if (txt.includes(w)) score++;
      }
      return { ...d, score };
    })
      .filter(d => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (hits.length) {
      (async () => {
        for (const h of hits) {
          const text = `Source: ${h.title}\n${h.content}\n\n`;
          res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
          await new Promise(r => setTimeout(r, 220));
        }
        res.write('data: [DONE]\n\n');
        res.end();
      })();
      return;
    }

    // Nothing found
    res.write(`data: ${JSON.stringify({ chunk: 'No matches found.' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    console.error('Stream error:', e);
    res.write(
      `event: error\ndata: ${JSON.stringify({ error: e.message || String(e) })}\n\n`
    );
    res.end();
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`OpenAI available: ${!!openai}`);
  console.log(`Embeddings loaded: ${EMB.length}`);
  console.log(`KB entries: ${KB.length}`);
});
