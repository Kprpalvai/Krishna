const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');

const key = process.env.OPENAI_API_KEY;
if(!key){
  console.error('ERROR: Set OPENAI_API_KEY in environment to create embeddings.');
  process.exit(1);
}
const client = new OpenAI({ apiKey: key });

async function createEmbeddings(){
  const kbPath = path.join(__dirname,'copilot-kb.json');
  if(!fs.existsSync(kbPath)){
    console.error('copilot-kb.json not found');
    process.exit(1);
  }
  const kb = JSON.parse(fs.readFileSync(kbPath,'utf8'));
  const out = [];
  for(const doc of kb){
    const txt = (doc.title||'') + '\n\n' + (doc.content||'');
    try{
      const r = await client.embeddings.create({ model: 'text-embedding-3-small', input: txt });
      const emb = r.data[0].embedding;
      out.push({ id: doc.id, title: doc.title, content: doc.content, embedding: emb });
      console.log('Indexed', doc.id);
    }catch(e){
      console.error('Embedding error for',doc.id,e.message||e);
    }
  }
  const outPath = path.join(__dirname,'copilot-embeddings.json');
  fs.writeFileSync(outPath, JSON.stringify(out,null,2),'utf8');
  console.log('Wrote', outPath);
}

createEmbeddings().catch(e=>{console.error(e);process.exit(1);});
