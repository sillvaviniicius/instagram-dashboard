# Dashboard Instagram (dados ao vivo)

Backend Node.js + Express que busca métricas do Instagram direto da API do
Windsor.ai e serve um dashboard que se atualiza sozinho (cache de 1h,
com botão para forçar atualização).

## 1. Pegar sua chave de API do Windsor.ai

1. Entre em https://onboard.windsor.ai (ou app.windsor.ai) com a conta que já
   tem o Instagram conectado.
2. Vá em **Settings / API Key** (ou no menu de integrações) e copie sua
   `api_key`.
3. Guarde essa chave — ela é o único segredo que este projeto precisa.

## 2. Rodar localmente (opcional, para testar)

```bash
npm install
cp .env.example .env
# edite .env e cole sua WINDSOR_API_KEY
npm start
```

Abra http://localhost:3000

## 3. Colocar online (Render.com — grátis)

1. Crie uma conta em https://render.com
2. Suba esta pasta para um repositório no GitHub (pode ser privado)
3. No Render: **New +** → **Web Service** → conecte o repositório
4. Configurações:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Em **Environment**, adicione a variável:
   - `WINDSOR_API_KEY` = sua chave copiada no passo 1
6. Clique em **Create Web Service** — o Render te dá uma URL pública tipo
   `https://seu-dashboard.onrender.com`

Alternativas equivalentes: **Railway.app**, **Fly.io**, ou **Vercel**
(usando este server.js como uma função serverless).

## Instalar como app no celular (PWA)

O dashboard agora pode ser "instalado" na tela inicial do celular e abrir
em tela cheia, como um app de verdade — sem precisar publicar em loja de
aplicativos.

**No Android (Chrome):**
1. Abra o link do dashboard
2. Toque nos três pontinhos (⋮) no canto superior direito
3. Toque em **"Instalar app"** ou **"Adicionar à tela inicial"**

**No iPhone (Safari):**
1. Abra o link do dashboard
2. Toque no ícone de compartilhar (□ com uma seta pra cima)
3. Toque em **"Adicionar à Tela de Início"**

Depois disso, um ícone aparece na tela inicial igual a qualquer outro app,
abrindo o dashboard em tela cheia (sem a barra de endereço do navegador).

## Adicionar senha de acesso

Por padrão o dashboard fica público para quem tiver o link. Se quiser
proteger com senha:

1. No painel do Render, vá em **Environment**
2. Adicione a variável:
   - **Key:** `DASHBOARD_PASSWORD`
   - **Value:** a senha que você quiser
3. Salve — o Render redesenha automaticamente

A partir daí, ao abrir o link, o navegador vai pedir usuário/senha (pode
deixar o campo de usuário em branco ou preencher qualquer coisa — só a
senha é verificada). Para remover a senha depois, é só apagar essa
variável de ambiente.

## Adicionar sua foto de perfil

O Instagram não libera a foto de perfil pela API usada aqui, então você
adiciona a sua manualmente:

1. Salve sua foto com o nome exato **`avatar.jpg`** (formato quadrado, ex:
   400x400px, fica melhor)
2. Coloque o arquivo dentro da pasta **`public/`**, junto do `index.html`
3. Suba pro GitHub (arraste o `avatar.jpg` junto com os outros arquivos no
   "Add file → Upload files")

Se o arquivo não existir, o dashboard volta a mostrar as iniciais do nome
automaticamente — nada quebra.

## Como funciona

- `GET /api/metrics` chama a API do Windsor.ai
  (`https://connectors.windsor.ai/instagram`) com sua chave, busca:
  - dados do perfil (seguidores, posts)
  - série diária dos últimos 30 dias (alcance, interações, curtidas, etc.)
  - os posts do período, para montar o ranking dos top 5
- Os resultados ficam em cache por 1 hora em memória, para não estourar
  limites de requisição. Adicione `?refresh=1` na URL do endpoint (ou clique
  em "Atualizar agora" no dashboard) para forçar uma nova busca.
- O frontend (`public/index.html`) é estático e só consome esse endpoint —
  nenhum dado fica hardcoded.

## Observação sobre planos do Windsor.ai

Contas gratuitas do Windsor.ai têm limites de requisições/volume de dados.
Se o dashboard for usado por muitas pessoas ao mesmo tempo, o cache de 1h
evita estourar esse limite — pode aumentar `CACHE_TTL_MS` em `server.js` se
precisar.
