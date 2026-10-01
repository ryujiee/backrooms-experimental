# BACKROOMS: NO-CLIP

Um jogo curto de terror em primeira pessoa nas Backrooms, rodando no navegador com
Three.js e Web Audio API. Cada partida gera um novo labirinto de papel de parede
amarelo, carpete úmido e lâmpadas fluorescentes zumbindo — e algo que acorda quando
você começa a religar a energia.

![Menu](docs/screenshots/menu.jpg)

| | |
|---|---|
| ![Corredor](docs/screenshots/corridor.jpg) | ![Salão com pilares](docs/screenshots/hall.jpg) |
| ![Quadro de energia](docs/screenshots/panel.jpg) | ![TV e fita](docs/screenshots/tv.jpg) |
| ![A criatura](docs/screenshots/creature.jpg) | ![Porta de saída](docs/screenshots/door.jpg) |

## O jogo

Você acorda no carpete sem lembrar como chegou ali. Não há mapa nem tutorial, só
uma linha de texto no canto da tela:

1. **Religue a energia** — encontre o quadro elétrico e segure `E`. Os setores
   apagados voltam a piscar… e algo grita ao longe.
2. **Encontre a fita** — siga a estática da TV até uma fita VHS. Ela mostra uma porta
   de metal sob uma luz vermelha. Partes do mapa perdem energia para sempre.
3. **Force a saída** — encontre a porta sob a luz vermelha e segure `E`. Um alarme
   dispara e a porta leva 25 segundos para abrir. *Ela ouviu.* Sobreviva e caminhe
   para a luz.

Uma primeira partida leva algo entre 15 e 30 minutos. Ao morrer, dá para voltar ao
último objetivo concluído (ou recomeçar a fita inteira). Cada partida tem uma seed:
ela aparece nas telas finais e pode ser digitada nas configurações para repetir um
mapa.

### Controles

| Tecla | Ação |
|---|---|
| `W` `A` `S` `D` | andar |
| Mouse | olhar |
| `Shift` | correr (gasta fôlego, faz barulho) |
| `C` | agachar (lento, quase silencioso) |
| `F` | lanterna (tem bateria; pilhas ficam espalhadas pelo chão) |
| `E` | interagir (segure quando pedido) |
| `Tab` | ver o objetivo atual |
| `Esc` | pausar |

Use fones de ouvido: os sons são posicionados em 3D e a criatura costuma ser ouvida
antes de ser vista.

## Requisitos

- Navegador desktop com WebGL 2 e aceleração de hardware (Chrome, Edge ou Firefox
  recentes), teclado e mouse. Em celulares/tablets o jogo mostra um aviso em vez de
  uma interface quebrada.
- Desenvolvimento: Node.js 20+ (testado com Node 24).

## Rodando

```bash
npm install
npm run dev       # servidor de desenvolvimento em http://localhost:5173
npm run build     # build estático em dist/
npm run preview   # serve o build de produção localmente
npm test          # testes unitários (node:test, sem dependências extras)
```

`dist/` é um site estático com caminhos relativos: pode ser publicado como está no
GitHub Pages (inclusive em subcaminho de projeto), Netlify, Vercel ou qualquer
servidor estático. Abrir o `index.html` direto do disco não é suportado (navegadores
bloqueiam módulos ES e fetch de assets em `file://`); use `npm run dev` ou
`npm run preview`.

## Configurações

Volume geral / efeitos / ambiente, sensibilidade do mouse, campo de visão, qualidade
(Automática, Baixa, Média, Alta), tela cheia, reduzir movimento da câmera, legendas
de sons importantes e seed opcional. Configurações, melhor tempo e conclusão ficam no
`localStorage`.

Os presets de qualidade controlam pixel ratio, sombras da lanterna, número de luzes
reais perto do jogador, pós-processamento (passe VHS, bloom, MSAA) e distância de
visão. *Automática* escolhe um preset pela GPU e pela tela, e reduz um nível se os
frames ficarem lentos de forma consistente.

## Arquitetura

```
index.html, styles/main.css        menus, HUD, overlay VHS (DOM)
scripts/main.js                    boot, máquina de estados, loop com timestep fixo, configurações
scripts/core/                      rng (com seed), settings (storage), assets (preload), log
scripts/game/                      lógica pura, sem Three.js — coberta por testes
  grid.js        grade de células, paredes nas arestas, conversões de coordenadas
  procgen.js     zonas, labirinto, salas, salões com pilares, corredores, landmarks, validação
  placement.js   transformações de props/objetivos (compartilhadas por render e colisão)
  collision.js   círculo x AABB com substeps, raster de ocupação para linha de visão
  pathfinding.js BFS e campos de distância
  lightfield.js  irradiância das lâmpadas assada, com oclusão por paredes
  player.js      movimento com aceleração, agachar, passos/ruído
  stamina.js     fôlego com histerese de exaustão
  monster.js     percepção da criatura (visão + audição) e máquina de estados
  director.js    tensão, ritmo, agendamento de eventos e aparições
  spots.js       consultas de posicionamento justo (fora de vista, longe o bastante)
  objectives.js  os três objetivos e a fuga
scripts/systems/                   Three.js / Web Audio / DOM
  session.js     uma partida: liga mapa, mundo, criatura, director e objetivos; dispose()
  world.js       geometria mesclada por chunk, props e lâmpadas instanciados, cenários
  lampShader.js  patch de shader que soma a luz assada + variação macro
  textures.js    texturas procedurais em canvas (papel de parede, carpete, forro, decals…)
  view.js        sensação de câmera (bob, sway, shake) e a lanterna
  monsterView.js modelo da criatura com animação procedural
  audio.js       buses, camadas de ambiente, one-shots espaciais, síntese
  effects.js     pós-processamento (bloom, tone mapping, passe VHS)
  quality.js     presets e escolha automática
  input.js       teclado, mouse, pointer lock
  ui.js          telas, formulário de configurações, HUD
  debug.js       overlay e ganchos de QA apenas em desenvolvimento
tests/                             suítes node:test para scripts/game e settings
tools/qa.mjs                       QA automatizada no navegador (Chrome DevTools Protocol / WebDriver BiDi)
tools/optimize-glb.mjs             como o modelo da lanterna foi otimizado
```

Decisões principais:

- **Estados explícitos** (`LOADING → MENU → INTRO → PLAYING ⇄ PAUSED → DEAD/WIN`).
  Cada partida é uma `Session` que é dona de tudo que cria e desmonta tudo em
  `dispose()`; listeners da página são registrados uma única vez.
- **Simulação fixa a 60 Hz** com renderização interpolada. O delta de frame é limitado
  (troca de aba, travadas) e a simulação nunca roda pausada, com a aba oculta ou sem
  pointer lock.
- **Iluminação**: centenas de lâmpadas do teto são assadas numa textura 2D de
  irradiância (com oclusão por paredes) amostrada por todas as superfícies, em vez de
  centenas de luzes reais. Um pequeno pool de luzes reais segue as lâmpadas que
  *piscam* perto do jogador; a lanterna é um spot com textura (cookie) e sombras.
- **Geometria**: piso, forro e paredes mesclados por chunk de 12×12 células; lâmpadas e
  props instanciados. Um frame típico tem ~40–60 draw calls, incluindo sombra e
  pós-processamento.
- **Geração procedural segura**: todo mapa é validado após ser gerado (conectividade
  total, objetivos/saída/pilhas alcançáveis, nada dentro de paredes, distâncias
  mínimas, criatura nascendo fora de vista). Mapas inválidos são regerados com número
  limitado de tentativas.
- **IA da criatura**: estados `DORMANT, IDLE, PATROL, INVESTIGATE, SEARCH, STALK, CROSS,
  ALERT, CHASE, COOLDOWN, ATTACK`. Ela só percebe o jogador por visão (distância, cone,
  linha de visão, quão iluminado ele está, lanterna, agachado) e som (passos,
  interações, atenuados por paredes e com erro de posição). Procura na última posição
  conhecida e depois recua. A ameaça cresce com o progresso: no começo ela só aparece,
  observa e some; caça de verdade depois da fita.
- **Regras de justiça**: sem percepção nos primeiros 75 s; a criatura só é reposicionada
  quando o jogador não pode ver o destino e ele está longe; a velocidade de
  perseguição é menor que a corrida, todo chase começa com um alerta curto, a captura
  exige linha de visão e cada perseguição é seguida de uma janela de alívio.
- **Director**: mantém um valor de tensão (progresso, proximidade, perseguição,
  escuridão, eventos recentes) que controla drones, batimento, respiração e efeitos de
  imagem, e agenda eventos raros com intervalos globais, cooldown por evento e
  liberação por estágio.

### Modo debug (apenas desenvolvimento)

Com `npm run dev`, aperte `F3` (ou abra `/?debug`) para um overlay com FPS, draw
calls, seed, estado do jogador e da criatura, o caminho da criatura, tensão e timers do
director. `F4` leva ao objetivo atual, `F6` liga o modo deus, `F7` traz a criatura
para perto e `F8` liga um piloto automático que anda até os objetivos usando a
colisão real. Nada disso entra no build de produção.

### QA automatizada

`tools/qa.mjs` controla o build de desenvolvimento no Chrome headless (GPU real via
ANGLE/EGL) ou no Firefox (WebDriver BiDi) e grava relatórios JSON e capturas em
`.qa/`:

```bash
# Servidor "congelado" (sem HMR/watch): editar código não recarrega um teste em andamento.
QA_NO_HMR=1 npx vite --port 5174 &
export QA_URL=http://localhost:5174/

node tools/qa.mjs smoke                 # boot, jogo, pausa, estatísticas de render
node tools/qa.mjs playthrough s1 s2 s3  # piloto automático completa partidas inteiras
node tools/qa.mjs restart 12            # stress de reinício (memória, objetos de GPU, DOM)
node tools/qa.mjs longrun 10 [estágio]  # minutos de jogo com amostragem
node tools/qa.mjs edge                  # pausa congela, pausa no blur, morte, troca de qualidade
node tools/qa.mjs checkpoint            # morte -> voltar ao último objetivo
node tools/qa.mjs assetfail             # todos os modelos/sons bloqueados: fallbacks
node tools/qa.mjs firefox               # smoke test no Firefox
node tools/qa.mjs readme                # regenera docs/screenshots
QA_URL=http://localhost:4173/ node tools/qa.mjs prodflow   # build de produção (npm run preview)
```

Rode um cenário por vez: cada um abre um navegador com aceleração de GPU.

## Assets e licenças

| Asset | Origem | Licença |
|---|---|---|
| Modelo da criatura `bacteria_lifeform_backrooms.glb` | "Bacteria Lifeform (Backrooms)" por [VHSvince](https://sketchfab.com/VHSvince), [Sketchfab](https://sketchfab.com/3d-models/bacteria-lifeform-backrooms-0d481d63f87d40e9bbcab60902ddf10a) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Modelo da lanterna `old_flashlight.glb` | "Old Flashlight" por [Blender3D](https://sketchfab.com/Blender3D), [Sketchfab](https://sketchfab.com/3d-models/old-flashlight-576daeaa281840cfb3ece4850cc42469) — texturas reduzidas, transmission removido | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `assets/source/original_backrooms.glb` (não publicado) | "Original Backrooms" por [Huuxloc](https://sketchfab.com/rjh41), Sketchfab | CC BY 4.0 |
| `footstep.ogg`, `flashlight_click.ogg`, `monster_scream.ogg` | Já existiam no repositório; origem não documentada | **Não verificada** — substitua por gravações CC0 em caso de dúvida (sem eles o jogo usa sons sintetizados) |
| Texturas, ambiente, zumbido, drones, batidas, respiração, batimento, alarmes | Gerados proceduralmente em tempo de execução por este projeto | Licença do projeto |
| Fonte Space Mono | [@fontsource/space-mono](https://fontsource.org/fonts/space-mono) | SIL OFL 1.1 |
| three.js | [threejs.org](https://threejs.org) | MIT |

As atribuições CC BY também aparecem no jogo, em *Créditos*.
