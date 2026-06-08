const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static site (the current folder)
app.use(express.static(path.join(__dirname)));

// Load local KB (simple JSON array of {id,title,content})
let KB = [];
let EMB = [];
try{
  const raw = fs.readFileSync(path.join(__dirname,'copilot-kb.json'),'utf8');
  KB = JSON.parse(raw);
  console.log('Loaded KB entries:', KB.length);
}catch(e){
  console.warn('No copilot-kb.json found or invalid JSON; KB empty.');
}

// try to load precomputed embeddings
try{
  const raw = fs.readFileSync(path.join(__dirname,'copilot-embeddings.json'),'utf8');
  EMB = JSON.parse(raw);
  console.log('Loaded embeddings:', EMB.length);
}catch(e){
  console.warn('No copilot-embeddings.json found; embeddings empty.');
}

// OpenAI client (optional)
const OPENAI_KEY = process.env.OPENAI_API_KEY || null;
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

function dot(a,b){let s=0; for(let i=0;i<a.length;i++) s+=a[i]*b[i]; return s}
function norm(a){let s=0; for(let i=0;i<a.length;i++) s+=a[i]*a[i]; return Math.sqrt(s)}
function cosineSim(a,b){ return dot(a,b)/(norm(a)*norm(b)+1e-12) }

async function embedText(text){
  if(!openai) return null;
  const r = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text });
  return r.data[0].embedding;
}

function searchEmbeddings(queryEmbedding, topK=3){
  if(!queryEmbedding || !EMB || EMB.length===0) return [];
  const scored = EMB.map(d=>({ ...d, score: cosineSim(queryEmbedding,d.embedding) }));
  return scored.sort((a,b)=>b.score-a.score).slice(0,topK);
}

// route to rebuild embeddings server-side (requires OPENAI_API_KEY)
app.post('/api/index', async (req,res)=>{
  if(!openai) return res.status(400).json({ error: 'OPENAI_API_KEY not set' });
  try{
    const kb = KB;
    const out = [];
    for(const doc of kb){
      const txt = (doc.title||'') + '\n\n' + (doc.content||'');
      const r = await openai.embeddings.create({ model: 'text-embedding-3-small', input: txt });
      const emb = r.data[0].embedding;
      out.push({ id: doc.id, title: doc.title, content: doc.content, embedding: emb });
    }
    fs.writeFileSync(path.join(__dirname,'copilot-embeddings.json'), JSON.stringify(out,null,2),'utf8');
    EMB = out;
    return res.json({ ok:true, indexed: out.length });
  }catch(e){console.error(e);return res.status(500).json({ error: e.message||String(e) });}
});

// /api/copilot: accepts {query,context,history} and returns {reply, sources}
app.post('/api/copilot', async (req, res) => {
  const { query, context, history } = req.body || {};
  if(!query) return res.status(400).json({ error: 'missing query' });

  // If we have embeddings, compute query embedding and retrieve top hits
  if(openai && EMB && EMB.length>0){
    try{
      const qemb = await embedText(query);
      const hits = searchEmbeddings(qemb,4);
      const contextText = hits.map(h=>`[${h.id}] ${h.title}\n${h.content}`).join('\n\n---\n\n');

      // If OpenAI key present, synthesize an answer using retrieved context
      if(openai){
        const system = `You are a helpful assistant that answers user questions using the provided research excerpts. If the answer is not contained, say you don't know.`;
        const messages = [
          { role: 'system', content: system },
          { role: 'system', content: 'Context:\n' + contextText },
          { role: 'user', content: query }
        ];
        const chat = await openai.chat.completions.create({ model: 'gpt-3.5-turbo', messages, max_tokens: 400 });
        const reply = chat.choices?.[0]?.message?.content || chat.choices?.[0]?.text || 'No reply';
        return res.json({ reply, sources: hits.map(h=>({id:h.id,title:h.title,score:h.score})) });
      }
      // fallback: return hits
      const reply = 'Top matches from local embeddings:\n\n' + hits.map(h=>`- ${h.title}: ${h.content.slice(0,600)}`).join('\n\n');
      return res.json({ reply, sources: hits.map(h=>({id:h.id,title:h.title,score:h.score})) });
    }catch(e){console.error(e);} 
  }

  // fallback to simple keyword retrieval if no embeddings or error
  const q = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = KB.map(d=>{const txt=(d.title+' '+d.content).toLowerCase();let score=0;for(const w of q) if(txt.includes(w)) score++; return {...d,score}}).filter(d=>d.score>0).sort((a,b)=>b.score-a.score).slice(0,3);
  if(hits.length){
    const reply = 'Top matches from research documents:\n\n' + hits.map(h=>`- ${h.title}: ${h.content.slice(0,600)}`).join('\n\n');
    return res.json({ reply, sources: hits.map(h=>({id:h.id,title:h.title,score:h.score})) });
  }

  return res.json({ reply: "I couldn't find a matching research excerpt locally. You can POST to /api/index with an OPENAI_API_KEY to build embeddings." });
});

// Streaming endpoint: proxy OpenAI streaming responses to the client
app.post('/api/copilot/stream', async (req, res) => {
  const { query, context, history } = req.body || {};
  if(!query) return res.status(400).json({ error: 'missing query' });

  // set streaming headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  // If OpenAI available and embeddings present, build prompt and stream
  if(OPENAI_KEY && EMB && EMB.length>0){
    try{
      const qemb = await embedText(query);
      const hits = searchEmbeddings(qemb,4);
      const contextText = hits.map(h=>`[${h.id}] ${h.title}\n${h.content}`).join('\n\n---\n\n');

      const system = `You are a helpful assistant that answers user questions using the provided research excerpts. If the answer is not contained, say you don't know.`;
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
          'Authorization': `Bearer ${OPENAI_KEY}`,
        },
        body: JSON.stringify({ model: 'gpt-3.5-turbo', messages, max_tokens: 600, stream: true }),
      });

      if(!openaiRes.ok){
        const txt = await openaiRes.text();
        res.write(`event: error\ndata: ${JSON.stringify({error: txt})}\n\n`);
        return res.end();
      }

      const reader = openaiRes.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let done = false;
      // stream parsing: OpenAI sends lines like 'data: {json}\n\n'
      while(!done){
        const { value, done: rdone } = await reader.read();
        if(rdone) break;
        const chunk = decoder.decode(value, { stream: true });
        const parts = chunk.split(/\n\n/).map(p=>p.trim()).filter(Boolean);
        for(const part of parts){
          if(!part.startsWith('data:')) continue;
          const payload = part.replace(/^data:\s*/,'').trim();
          if(payload === '[DONE]'){
            done = true; break;
          }
          try{
            const j = JSON.parse(payload);
            const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
            if(delta){
              // send small text chunks to client as structured JSON
              res.write(`data: ${JSON.stringify({text: delta})}\n\n`);
            }
          }catch(e){
            // ignore parse errors
          }
        }
      }
      // After streaming content, send sources event so client can render them
      try{
        const sources = hits.map(h=>({id:h.id,title:h.title,score:h.score}));
        res.write(`event: sources\ndata: ${JSON.stringify(sources)}\n\n`);
      }catch(e){/* ignore */}
      res.write('data: [DONE]\n\n');
      return res.end();
    }catch(e){
      console.error('stream error',e); res.write(`event: error\ndata: ${JSON.stringify({error: e.message||String(e)})}\n\n`); return res.end();
    }
  }

  // Fallback streaming: stream matching local KB excerpts as chunks
  const q = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = KB.map(d=>{const txt=(d.title+' '+d.content).toLowerCase();let score=0;for(const w of q) if(txt.includes(w)) score++; return {...d,score}}).filter(d=>d.score>0).sort((a,b)=>b.score-a.score).slice(0,3);
  if(hits.length){
    (async ()=>{
      for(const h of hits){
        const text = `Source: ${h.title}\n${h.content}\n\n`;
        res.write(`data: ${JSON.stringify({chunk: text})}\n\n`);
        await new Promise(r=>setTimeout(r,220));
      }
      res.write('data: [DONE]\n\n');
      res.end();
    })();
    return;
  }

  // nothing found
  res.write(`data: ${JSON.stringify({chunk: "No matches found."})}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`Server listening on http://localhost:${PORT}`));
