# KOMAND Live

Salas para transmitir a tela pelo navegador. Sem instalar nada, sem cadastro.

**https://transmissor-tela.onrender.com**

1. Escolha um apelido e clique em **Criar sala** (ou cole o código de uma sala e clique em **Entrar**).
2. Mande o **link do convite** ou o **código** (ex.: `AB12-CD34`) para a turma.
3. Clique em **Compartilhar tela** (no computador, com Chrome, Edge ou Firefox).

- Várias pessoas podem transmitir ao mesmo tempo; cada um escolhe na lista **Transmitindo** quem quer assistir.
- No celular dá para assistir e reagir; para transmitir precisa de um computador.
- Salas vazias somem depois de 30 minutos. Se o servidor reiniciar, é só criar uma sala nova.

## Como está hospedado

- **Render** (plano grátis) roda o `server.js`. Configuração em `render.yaml`.
- **Cloudflare TURN** ("ponte" para quando a conexão direta falha): variáveis `CF_TURN_KEY_ID` e `CF_TURN_API_TOKEN` no Environment do Render.
- **GitHub Actions** (`.github/workflows/manter-acordado.yml`) visita o site a cada 10 minutos para ele não "dormir".
- Para publicar uma alteração: troque os arquivos aqui no GitHub e, no Render, clique em **Manual Deploy → Deploy latest commit**.

## Rodar no seu próprio PC

Precisa do [Node.js](https://nodejs.org).

- `iniciar.bat`: liga o servidor e cria um link público temporário.
- `iniciar-so-rede-local.bat`: só para quem está no mesmo Wi-Fi.
