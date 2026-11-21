# Transmissor de Tela

Compartilhe a tela com seus amigos pelo navegador. Quem tem o link assiste; quem tem a senha também pode apresentar a própria tela. Uma pessoa apresenta por vez.

- `/assistir` — ver a transmissão (funciona no celular também)
- `/transmitir` — apresentar a sua tela (precisa de computador com Chrome, Edge ou Firefox)

---

## Deixar no ar 24h, de graça (Render)

Assim funciona mesmo com o seu PC desligado.

### 1. Colocar o código no GitHub
1. Crie uma conta em https://github.com (grátis).
2. Clique em **+** (canto superior direito) → **New repository**.
3. Nome: `transmissor-tela`. Pode deixar **Public** ou **Private**. Clique em **Create repository**.
4. Na página que abrir, clique no link **uploading an existing file**.
5. Arraste **todo o conteúdo** desta pasta (os arquivos `server.js`, `package.json`, `render.yaml`, `README.md` e a pasta `public`) para a página.
6. Clique em **Commit changes**.

### 2. Publicar no Render
1. Crie uma conta em https://render.com (grátis) — dá para entrar com a conta do GitHub.
2. No painel, clique em **New +** → **Blueprint**.
3. Conecte o GitHub e escolha o repositório `transmissor-tela`.
4. O Render vai pedir o valor de **SHARE_CODE**: é a **senha para apresentar a tela**. Escolha uma e guarde.
5. Clique em **Apply** / **Deploy** e espere uns 2 minutos.
6. Pronto! O link aparece no topo do serviço, algo como `https://transmissor-tela-xxxx.onrender.com`.

### 3. Mandar para os amigos
- Para assistir: `https://SEU-LINK.onrender.com/assistir`
- Para apresentar: `https://SEU-LINK.onrender.com/transmitir` + a senha

### Bom saber
- No plano grátis, se ninguém usar por ~15 minutos o servidor "dorme". O primeiro a entrar depois espera uns 30–60 segundos e então funciona normal.
- Para trocar a senha: no Render, abra o serviço → **Environment** → edite `SHARE_CODE` → **Save**.
- Para atualizar o programa: troque os arquivos no GitHub; o Render publica de novo sozinho.

---

## Rodar no seu próprio PC (sem hospedar)

Precisa do [Node.js](https://nodejs.org) instalado.

- `iniciar.bat` — liga o servidor e cria um link público temporário (via localhost.run). O link e a senha aparecem na página de transmitir.
- `iniciar-so-rede-local.bat` — só para quem está no mesmo Wi‑Fi.
