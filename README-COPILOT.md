Copilot backend stub and local KB

Quick start (Windows PowerShell):

1. Install dependencies

```powershell
npm install
```

2. Run the server

```powershell
npm start
```

3. Open the site in your browser

Navigate to: http://localhost:3000/index.html

What this provides
- A minimal Express server that serves the static `index.html` and exposes `/api/copilot`.
- A local knowledge base `copilot-kb.json` used for lightweight retrieval.

Next steps to improve
- Replace the simple `localSearch` with an embedding-based retriever + vector DB for better relevance.
- Integrate an LLM call in `/api/copilot` (server-side) to synthesize answers from retrieved context. Keep LLM API keys server-side.
- Add metadata in responses (source ids) so frontend can show sources.
