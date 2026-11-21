# Transmissor de Tela

Uma sala na internet para compartilhar a tela com os amigos, pelo navegador. **Um link só**, sem senha:

**https://transmissor-tela.onrender.com**

- Abriu o link → já está assistindo (funciona no celular também).
- Quer mostrar a sua tela? Clique em **🖥️ Compartilhar minha tela** (precisa ser computador com Chrome, Edge ou Firefox).
- Uma pessoa apresenta por vez. Enquanto alguém apresenta, o botão fica bloqueado; quando ela parar, outra pode começar.

## Como está hospedado

O site roda de graça no [Render](https://render.com), usando o código deste repositório (configuração em `render.yaml`).

- No plano grátis, se ninguém usar por ~15 minutos o servidor "dorme". O primeiro a entrar depois espera uns 30–60 segundos e então funciona normal.
- Para publicar uma alteração: troque os arquivos aqui no GitHub e, no Render, abra o serviço e clique em **Manual Deploy → Deploy latest commit**.

## Rodar no seu próprio PC (sem hospedar)

Precisa do [Node.js](https://nodejs.org) instalado.

- `iniciar.bat` — liga o servidor e cria um link público temporário (via localhost.run).
- `iniciar-so-rede-local.bat` — só para quem está no mesmo Wi‑Fi.
